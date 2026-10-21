import type { SearchProvider } from '../provider.js';
import { demoBusesProvider } from './buses.js';
import { demoCabsProvider } from './cabs.js';
import { demoFlightsProvider } from './flights.js';
import { demoHolidaysProvider } from './holidays.js';
import { demoHotelsProvider } from './hotels.js';
import { demoMetroProvider } from './metro.js';
import { demoTrainsProvider } from './trains.js';

/**
 * The built-in demo providers, one per category. They serve fixed fixtures
 * (docs/search.md#demo-data), never call the network, and are labelled `demo`
 * everywhere their results appear.
 */
export const DEMO_PROVIDERS: readonly SearchProvider[] = [
  demoFlightsProvider,
  demoHotelsProvider,
  demoTrainsProvider,
  demoBusesProvider,
  demoMetroProvider,
  demoCabsProvider,
  demoHolidaysProvider,
];
