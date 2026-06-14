import type { CollectionCreateSchema } from 'typesense/lib/Typesense/Collections.js';

export const adresseSchema: CollectionCreateSchema = {
  name: 'adresses',
  fields: [
    { name: 'label', type: 'string' },
    { name: 'street_fr', type: 'string' },
    { name: 'street_nl', type: 'string' },
    { name: 'street_de', type: 'string' },
    { name: 'house_number', type: 'string' },
    { name: 'postal_code', type: 'string', facet: true },
    { name: 'municipality_fr', type: 'string', facet: true },
    { name: 'municipality_nl', type: 'string', facet: true },
    { name: 'municipality_de', type: 'string', facet: true },
    { name: 'region', type: 'string', facet: true },
    { name: 'lat', type: 'float' },
    { name: 'lng', type: 'float' },
  ],
  default_sorting_field: 'lat',
};

export interface Address {
  label: string;
  street_fr: string;
  street_nl: string;
  street_de: string;
  house_number: string;
  postal_code: string;
  municipality_fr: string;
  municipality_nl: string;
  municipality_de: string;
  region: string;
  lat: number;
  lng: number;
}
