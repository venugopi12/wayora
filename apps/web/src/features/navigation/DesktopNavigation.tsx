import { Link, useLocation } from 'react-router';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuTrigger,
  cn,
} from '@wayora/ui';
import { DISCOVER, HEADER_SERVICE_LINKS, MORE_MENU_PATHS, serviceBySlug } from './config';
import { TravelMegaMenu } from './TravelMegaMenu';

/** Desktop (lg+) primary navigation: Discover, core services, and "More". */
export function DesktopNavigation({ className }: { className?: string }) {
  const { pathname } = useLocation();
  const collapsedPaths = HEADER_SERVICE_LINKS.filter((l) => l.collapseBelowXl).map(
    (l) => serviceBySlug[l.slug].path,
  );
  const moreActive = MORE_MENU_PATHS.includes(pathname as (typeof MORE_MENU_PATHS)[number]);
  // Below xl, a collapsed item (Buses) lives in "More", so its page lights up "More" there.
  const moreActiveBelowXl = collapsedPaths.includes(pathname as (typeof collapsedPaths)[number]);

  return (
    <NavigationMenu label="Primary" className={className}>
      <NavigationMenuItem>
        <NavigationMenuLink variant="top" active={pathname === DISCOVER.path}>
          <Link to={DISCOVER.path}>{DISCOVER.name}</Link>
        </NavigationMenuLink>
      </NavigationMenuItem>

      {HEADER_SERVICE_LINKS.map(({ slug, collapseBelowXl }) => {
        const service = serviceBySlug[slug];
        return (
          <NavigationMenuItem
            key={slug}
            className={collapseBelowXl ? 'hidden xl:block' : undefined}
          >
            <NavigationMenuLink variant="top" active={pathname === service.path}>
              <Link to={service.path}>{service.name}</Link>
            </NavigationMenuLink>
          </NavigationMenuItem>
        );
      })}

      <NavigationMenuItem>
        <NavigationMenuTrigger
          sectionActive={moreActive || moreActiveBelowXl}
          className={cn(
            moreActiveBelowXl && !moreActive && 'xl:data-[section-active]:after:scale-x-0',
          )}
        >
          More
        </NavigationMenuTrigger>
        <NavigationMenuContent>
          <TravelMegaMenu />
        </NavigationMenuContent>
      </NavigationMenuItem>
    </NavigationMenu>
  );
}
