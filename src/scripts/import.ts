import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import sax from 'sax';
import unzipper from 'unzipper';
import proj4 from 'proj4';
import { pino } from 'pino';
import { createTypesenseClient } from '../typesense.js';
import { adresseSchema, type Address } from '../schema.js';

const log = pino({ level: 'info' });
const client = createTypesenseClient(60);

const BEST_DIR = process.env.BEST_DIR ?? '/tmp/best';
const BATCH_SIZE = 1000;

proj4.defs(
  'EPSG:31370',
  '+proj=lcc +lat_1=51.16666723333333 +lat_2=49.8333339 +lat_0=90 +lon_0=4.367486666666666 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.869,52.2978,-103.724,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs',
);

function lambert72ToWgs84(x: number, y: number): { lat: number; lng: number } {
  const [lng, lat] = proj4('EPSG:31370', 'WGS84', [x, y]);
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

function findZip(prefix: string): string {
  const files = fs.readdirSync(BEST_DIR);
  const match = files.find((f) => f.startsWith(prefix) && f.endsWith('.zip'));
  if (!match)
    throw new Error(`No zip found for prefix: ${prefix} in ${BEST_DIR}`);
  return path.join(BEST_DIR, match);
}

type Names = { fr: string; nl: string; de: string };
type NameMap = Map<string, Names>;

async function loadNameMap(
  zipPath: string,
  itemTag: string,
  region: string,
): Promise<NameMap> {
  const map: NameMap = new Map();
  let current: { id?: string; names: Names } = {
    names: { fr: '', nl: '', de: '' },
  };
  let inName = false;
  let currentLang = '';

  const directory = await unzipper.Open.file(zipPath);

  await new Promise<void>((resolve, reject) => {
    const saxParser = sax.createStream(true, { xmlns: false, trim: true });

    saxParser.on('opentag', ({ name }) => {
      if (name === itemTag) {
        current = { names: { fr: '', nl: '', de: '' } };
      } else if (name === 'com:name') {
        inName = true;
        currentLang = '';
      }
    });

    let textBuffer = '';

    saxParser.on('text', (text) => {
      textBuffer += text;
    });

    saxParser.on('closetag', (name) => {
      const text = textBuffer.trim();
      textBuffer = '';

      if (name === 'com:objectIdentifier' && !current.id) {
        current.id = text;
      } else if (name === 'com:language' && inName) {
        currentLang = text;
      } else if (name === 'com:spelling' && inName) {
        if (currentLang === 'fr') current.names.fr = text;
        else if (currentLang === 'nl') current.names.nl = text;
        else if (currentLang === 'de') current.names.de = text;
      } else if (name === 'com:name') {
        inName = false;
      } else if (name === itemTag && current.id) {
        map.set(current.id, { ...current.names });
      }
    });

    saxParser.on('error', reject);
    saxParser.on('end', resolve);

    directory.files[0].stream().pipe(saxParser);
  });

  log.info({ region, count: map.size }, `${itemTag} loaded`);
  return map;
}

async function importAddresses(
  zipPath: string,
  region: string,
  regionLabel: string,
  streets: NameMap,
  municipalities: NameMap,
  collectionName: string,
): Promise<number> {
  log.info({ region }, 'Importing addresses...');

  // Use sax.parser (not stream) so we can drive reading manually via for-await,
  // which gives us natural backpressure: the loop pauses while we flush to Typesense.
  const saxParser = sax.parser(true, { trim: true });
  const seen = new Set<string>();

  let batch: Address[] = [];
  let total = 0;
  let pendingFlush: Promise<void> = Promise.resolve();
  let parseError: Error | null = null;

  let inAddress = false;
  let status = '';
  let houseNumber = '';
  let streetId = '';
  let municipalityId = '';
  let postalCode = '';
  let posText = '';
  let textBuffer = '';
  let inPos = false;
  let inHasStreet = false;
  let inHasMunicipality = false;
  let inHasPostal = false;
  let inStatus = false;

  saxParser.onerror = (err) => {
    parseError = err;
    saxParser.resume();
  };

  saxParser.onopentag = ({ name }) => {
    textBuffer = '';
    if (name === 'tns:address') {
      inAddress = true;
      status =
        houseNumber =
        streetId =
        municipalityId =
        postalCode =
        posText =
          '';
    } else if (inAddress) {
      if (name === 'com:pos') inPos = true;
      else if (name === 'com:hasStreetName') inHasStreet = true;
      else if (name === 'com:hasMunicipality') inHasMunicipality = true;
      else if (name === 'com:hasPostalInfo') inHasPostal = true;
      else if (name === 'com:status') inStatus = true;
    }
  };

  saxParser.ontext = (text) => {
    textBuffer += text;
  };

  saxParser.onclosetag = (name) => {
    const text = textBuffer.trim();
    textBuffer = '';

    if (!inAddress) return;

    if (name === 'com:status' && inStatus) {
      status = text;
      inStatus = false;
    } else if (name === 'com:houseNumber') houseNumber = text;
    else if (name === 'com:pos' && inPos) {
      posText = text;
      inPos = false;
    } else if (name === 'com:objectIdentifier') {
      if (inHasStreet && !streetId) streetId = text;
      else if (inHasMunicipality && !municipalityId) municipalityId = text;
      else if (inHasPostal && !postalCode) postalCode = text;
    } else if (name === 'com:hasStreetName') inHasStreet = false;
    else if (name === 'com:hasMunicipality') inHasMunicipality = false;
    else if (name === 'com:hasPostalInfo') inHasPostal = false;
    else if (name === 'tns:address') {
      inAddress = false;
      if (status !== 'current' || !houseNumber || !posText) return;

      const street = streets.get(streetId) ?? { fr: '', nl: '', de: '' };
      const municipality = municipalities.get(municipalityId) ?? {
        fr: '',
        nl: '',
        de: '',
      };
      const [xStr, yStr] = posText.split(/\s+/);
      const { lat, lng } = lambert72ToWgs84(parseFloat(xStr), parseFloat(yStr));
      const streetName = street.fr || street.nl || street.de;
      const municipalityName =
        municipality.fr || municipality.nl || municipality.de;
      const label =
        `${streetName} ${houseNumber}, ${postalCode} ${municipalityName}`.trim();

      if (seen.has(label)) return;
      seen.add(label);

      batch.push({
        label,
        street_fr: street.fr,
        street_nl: street.nl,
        street_de: street.de,
        house_number: houseNumber,
        postal_code: postalCode,
        municipality_fr: municipality.fr,
        municipality_nl: municipality.nl,
        municipality_de: municipality.de,
        region: regionLabel,
        lat,
        lng,
      });

      if (batch.length >= BATCH_SIZE) {
        const toFlush = batch;
        batch = [];
        pendingFlush = pendingFlush.then(async () => {
          await client
            .collections<Address>(collectionName)
            .documents()
            .import(toFlush, { action: 'create' });
          total += toFlush.length;
          if (total % 100_000 === 0)
            log.info({ region, total }, 'addresses imported');
        });
      }
    }
  };

  const directory = await unzipper.Open.file(zipPath);
  const source = directory.files[0].stream();

  await new Promise<void>((resolve, reject) => {
    source.on('data', (chunk: Buffer) => {
      source.pause();
      saxParser.write(chunk.toString('utf8'));
      pendingFlush
        .then(() => {
          if (parseError) {
            reject(parseError);
            return;
          }
          source.resume();
        })
        .catch(reject);
    });
    source.on('end', resolve);
    // unzipper emits "invalid signature" when it hits the zip central directory
    // after streaming the last entry — treat it as a normal end-of-stream.
    source.on('error', (err: Error) => {
      if (err.message.startsWith('invalid signature')) resolve();
      else reject(err);
    });
  });

  saxParser.close();
  await pendingFlush;

  if (batch.length > 0) {
    await client
      .collections<Address>(collectionName)
      .documents()
      .import(batch, { action: 'create' });
    total += batch.length;
  }

  log.info({ region, total }, 'Region import complete');
  return total;
}

async function run(): Promise<void> {
  const newName = `adresses_${Date.now()}`;
  log.info({ collection: newName }, 'Creating new collection...');
  await client.collections().create({ ...adresseSchema, name: newName });

  const regions = [
    { prefix: 'Brussels', label: 'Bruxelles' },
    { prefix: 'Flanders', label: 'Flandre' },
    { prefix: 'Wallonia', label: 'Wallonie' },
  ];

  let grandTotal = 0;

  for (const { prefix, label } of regions) {
    const municipalities = await loadNameMap(
      findZip(`${prefix}Municipality`),
      'tns:municipality',
      prefix,
    );
    const streets = await loadNameMap(
      findZip(`${prefix}StreetName`),
      'tns:streetName',
      prefix,
    );
    const count = await importAddresses(
      findZip(`${prefix}Address`),
      prefix,
      label,
      streets,
      municipalities,
      newName,
    );
    grandTotal += count;
  }

  // Remove legacy collection named 'adresses' if it exists (pre-alias migration)
  try {
    await client.collections('adresses').delete();
    log.info('Deleted legacy adresses collection');
  } catch {
    /* not present, that's fine */
  }

  // Atomically point the alias to the new collection
  const alias = await client
    .aliases()
    .upsert('adresses', { collection_name: newName });
  log.info({ alias, grandTotal }, 'Alias updated');

  // Delete previous collection if any
  const allCollections = await client.collections().retrieve();
  for (const col of allCollections) {
    if (col.name !== newName && col.name.startsWith('adresses_')) {
      await client.collections(col.name).delete();
      log.info({ collection: col.name }, 'Old collection deleted');
    }
  }

  log.info({ grandTotal }, 'Import complete');
}

run().catch((err) => {
  log.error(err, 'Import failed');
  process.exit(1);
});
