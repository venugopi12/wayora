import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@wayora/ui';
import type { FooterGroup } from '../../features/navigation/footer';
import { FooterNavLink } from './FooterNavLink';

/**
 * Footer link groups on phones: an accordion (all closed, several can open)
 * so the footer stays short. Loaded lazily by SiteFooter.
 */
export default function GroupAccordions({ groups }: { groups: readonly FooterGroup[] }) {
  return (
    <Accordion type="multiple" className="border-t border-line-inverse">
      {groups.map((group) => (
        <AccordionItem key={group.id} value={group.id} tone="inverse" className="last:border-b-0">
          <AccordionTrigger headingLevel="h2" tone="inverse">
            {group.title}
          </AccordionTrigger>
          <AccordionContent>
            <ul aria-label={group.title} className="flex flex-col text-body">
              {group.links.map((link) => (
                <li key={link.to}>
                  {/* 44px rows: comfortable touch targets. */}
                  <FooterNavLink link={link} className="inline-flex min-h-11 items-center" />
                </li>
              ))}
            </ul>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
