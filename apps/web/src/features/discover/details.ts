/**
 * Long-form copy for each SAMPLE destination: the editorial intro and the
 * "why it's worth exploring" highlights shown on /discover/:slug.
 *
 * Kept apart from ./data.ts so that only the lazily loaded Discover pages
 * download it. Content rules: describe places in stable, well-known terms; no
 * prices, safety claims, current conditions or deals.
 */
import type { Destination, DestinationHighlight, DestinationSummary } from '@wayora/contracts';
import { DESTINATIONS } from './data';

interface DestinationDetails {
  intro: string;
  highlights: DestinationHighlight[];
}

const DETAILS: Record<string, DestinationDetails> = {
  goa: {
    intro:
      "Goa is India's smallest state and one of its best-loved coastlines: a long run of beaches, river estuaries and villages where Portuguese-era churches and whitewashed houses sit among palm groves. It suits slow days as easily as lively evenings.",
    highlights: [
      {
        title: 'A coastline to wander',
        text: 'Beaches range from busy stretches to quiet coves, so you can choose the pace of each day.',
      },
      {
        title: 'Portuguese-era heritage',
        text: "Old Goa's churches and the tiled lanes of Fontainhas in Panaji recall centuries of Portuguese rule.",
      },
      {
        title: 'Food from the coast',
        text: 'Seafood curries, vindaloo and xacuti come from a cuisine shaped by the sea and by history.',
      },
    ],
  },
  jaipur: {
    intro:
      "Rajasthan's capital is known as the Pink City for the terracotta-pink facades of its old walled centre. Palaces, hilltop forts and busy bazaars make it one of India's richest cities to explore on foot.",
    highlights: [
      {
        title: 'Forts above the city',
        text: 'Amber Fort and Nahargarh look out over the hills that ring Jaipur.',
      },
      {
        title: 'The old walled city',
        text: 'Lanes inside the old city gates are lined with bazaars for textiles, gems and block prints.',
      },
      {
        title: 'Royal craftsmanship',
        text: "Palaces and the Hawa Mahal's honeycomb of windows show the city's architectural detail.",
      },
    ],
  },
  kerala: {
    intro:
      "Kerala runs along India's south-west coast between the Arabian Sea and the Western Ghats. Its backwaters, tea-covered hills and long beaches make it a place to slow right down.",
    highlights: [
      {
        title: 'Backwater days',
        text: 'Houseboats drift through canals and lagoons lined with coconut palms around Alappuzha.',
      },
      {
        title: 'Hills of tea',
        text: 'Inland, the slopes around Munnar are covered in tea estates and cool, misty air.',
      },
      {
        title: 'Ayurveda traditions',
        text: 'Kerala is closely associated with Ayurveda, and many retreats build a stay around it.',
      },
    ],
  },
  manali: {
    intro:
      'Manali sits at the northern end of the Kullu Valley, surrounded by cedar forests and snow-capped peaks. It is a base for mountain walks, river valleys and high-altitude road journeys.',
    highlights: [
      {
        title: 'Cedar forests',
        text: 'Deodar forests and apple orchards climb the valley slopes around the town.',
      },
      {
        title: 'Old Manali',
        text: 'Wooden houses and cafés line the lanes, and the Hadimba temple stands in the forest nearby.',
      },
      {
        title: 'Toward the high Himalaya',
        text: 'Mountain roads lead on toward Rohtang and the high landscapes of Lahaul.',
      },
    ],
  },
  bengaluru: {
    intro:
      "Long known as India's Garden City, Bengaluru is also the centre of its technology industry: a fast-moving city of parks, cafés, breweries and new restaurants. It is a handy starting point for journeys into South India.",
    highlights: [
      {
        title: 'Green spaces',
        text: "Cubbon Park and Lalbagh's botanical gardens bring calm to the middle of the city.",
      },
      {
        title: 'A city that eats out',
        text: 'Classic South Indian breakfasts and a wave of new restaurants make food a reason to visit.',
      },
      {
        title: 'A base for the south',
        text: 'Mysuru, Coorg and the hills of the Western Ghats are within reach for a longer trip.',
      },
    ],
  },
  hyderabad: {
    intro:
      'Hyderabad pairs more than four centuries of history with a modern technology economy. The old city around the Charminar is full of bazaars, while the newer districts are known for their restaurants and growth.',
    highlights: [
      {
        title: 'The old city',
        text: 'Lanes around the Charminar are known for bangles, pearls and street food.',
      },
      {
        title: 'Golconda Fort',
        text: "The hilltop fort on the city's western edge was once the seat of a powerful sultanate.",
      },
      {
        title: 'Hyderabadi cuisine',
        text: "Biryani and other dishes from the city's royal kitchens are reason enough to visit.",
      },
    ],
  },
  mumbai: {
    intro:
      "Mumbai is India's financial capital and the home of its film industry: a city of colonial-era architecture, sea-facing promenades and neighbourhoods that seem to stay awake around the clock.",
    highlights: [
      {
        title: 'Marine Drive',
        text: "The curving seafront promenade glows at night, which earned it the name Queen's Necklace.",
      },
      {
        title: 'Historic landmarks',
        text: 'The Gateway of India and Chhatrapati Shivaji Maharaj Terminus anchor the south of the city.',
      },
      {
        title: 'Street food',
        text: 'Vada pav, pav bhaji and bhel puri are Mumbai classics worth seeking out.',
      },
    ],
  },
  delhi: {
    intro:
      "India's capital holds layers of history, from monuments built by successive dynasties to the lanes of Old Delhi and the broad avenues of New Delhi. It is a natural starting point for journeys across the north.",
    highlights: [
      {
        title: 'Centuries of monuments',
        text: "Humayun's Tomb, the Red Fort and the Qutub Minar span several of the city's ruling dynasties.",
      },
      {
        title: 'Old Delhi',
        text: "Chandni Chowk's lanes are known for spice markets, sweet shops and food stalls.",
      },
      {
        title: 'A gateway to the north',
        text: 'Jaipur and Agra are popular onward journeys from the capital.',
      },
    ],
  },
  bali: {
    intro:
      'Bali is an Indonesian island known for its Hindu temples, terraced rice fields, surf beaches and a long tradition of wellness retreats around Ubud.',
    highlights: [
      {
        title: 'Rice terraces',
        text: 'Green terraces such as Jatiluwih and Tegallalang step down the island’s hillsides.',
      },
      {
        title: 'Temples and ceremony',
        text: 'Temples on clifftops, lakes and village squares are at the heart of daily island life.',
      },
      {
        title: 'Coast and surf',
        text: 'The south of the island is known for surf breaks and long sunset beaches.',
      },
    ],
  },
  kyoto: {
    intro:
      "Kyoto was Japan's imperial capital for more than a thousand years. Its temples, shrines, gardens and wooden townhouses make it one of the world's most rewarding cities to explore slowly.",
    highlights: [
      {
        title: 'Temples and shrines',
        text: 'From grand temple complexes to small neighbourhood shrines, places of worship fill the city.',
      },
      {
        title: 'Historic streets',
        text: 'Districts such as Gion and Higashiyama preserve traditional wooden machiya townhouses.',
      },
      {
        title: 'Gardens through the seasons',
        text: 'Moss and rock gardens change character with spring blossom and autumn leaves.',
      },
    ],
  },
  singapore: {
    intro:
      'Singapore is a compact island city-state where gardens, a glittering waterfront and distinct neighbourhoods such as Chinatown, Little India and Kampong Glam sit side by side.',
    highlights: [
      {
        title: 'Gardens in the city',
        text: 'Green space runs through the city, from the Botanic Gardens to waterfront parks.',
      },
      {
        title: 'Hawker centres',
        text: 'Hawker centres serve dishes from Chinese, Malay, Indian and Peranakan traditions.',
      },
      {
        title: 'Neighbourhoods to walk',
        text: 'Chinatown, Little India and Kampong Glam each have their own character.',
      },
    ],
  },
  dubai: {
    intro:
      "Dubai rises from the desert on the Gulf coast, pairing some of the world's tallest buildings with an old trading quarter, souks and long beaches.",
    highlights: [
      {
        title: 'A modern skyline',
        text: 'Towers along Sheikh Zayed Road and in Downtown define one of the world’s most recognisable skylines.',
      },
      {
        title: 'Old Dubai',
        text: "Dubai Creek, its abra boats and the gold and spice souks recall the city's trading past.",
      },
      {
        title: 'The desert nearby',
        text: 'Sand dunes begin just beyond the edge of the city.',
      },
    ],
  },
};

/** A full destination (summary + long-form copy), or undefined if either is missing. */
export function withDetails(summary: DestinationSummary | undefined): Destination | undefined {
  const details = summary ? DETAILS[summary.slug] : undefined;
  return summary && details ? { ...summary, ...details } : undefined;
}

/** Every sample destination with its long-form copy (used by tests and the detail page). */
export const FULL_DESTINATIONS: readonly Destination[] = DESTINATIONS.map(withDetails).filter(
  (d): d is Destination => d !== undefined,
);
