import { Link } from 'react-router';
import { DestinationCard } from '@wayora/ui';
import { moodBySlug } from '../discover/data';
import { placeLine } from '../discover/format';
import { destinationPath } from '../discover/paths';
import { findDestination } from '../discover/search';

/** Destination cards for the slugs given, skipping any the dataset doesn't have. */
export function DestinationGrid({
  slugs,
  onOpen,
}: {
  slugs: readonly string[];
  onOpen?: () => void;
}) {
  const places = slugs.flatMap((s) => {
    const d = findDestination(s);
    return d ? [d] : [];
  });
  if (places.length === 0) return null;
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {places.map((d) => (
        <li key={d.slug} className="min-w-0">
          <DestinationCard
            className="h-full"
            name={d.name}
            region={placeLine(d)}
            description={d.description}
            image={d.image}
            sizes="(min-width: 1024px) 30vw, (min-width: 640px) 50vw, 100vw"
            tags={d.categories.map((c) => moodBySlug[c].title)}
            tagsLabel="Travel moods"
            link={<Link to={destinationPath(d.slug)} onClick={onOpen} />}
          />
        </li>
      ))}
    </ul>
  );
}
