import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ui from '@wayora/ui';
import * as motion from '@wayora/ui/motion';

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
  dependencies: Record<string, string>;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('package exports', () => {
  it('exposes exactly the documented entry points', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(
      ['.', './base.css', './motion', './theme.css'].sort(),
    );
  });

  it('resolves both entry points through the package name', () => {
    for (const name of [
      'Button',
      'Card',
      'Dialog',
      'DestinationCard',
      'DestinationImage',
      'PageHeader',
      'Accordion',
      'AccordionItem',
      'AccordionTrigger',
      'AccordionContent',
      'Breadcrumbs',
      'Eyebrow',
      'Prose',
      'interaction',
      'overlayMotion',
      'effects',
    ])
      expect(ui).toHaveProperty(name);
    for (const name of [
      'Reveal',
      'RevealGroup',
      'RevealItem',
      'LineReveal',
      'DrawPath',
      'ImageReveal',
      'Parallax',
      'useMotionPreferences',
      'fadeIn',
      'fadeUp',
      'fadeDown',
      'scaleIn',
      'sectionReveal',
      'staggerContainer',
      'transitions',
    ])
      expect(motion).toHaveProperty(name);
    // One object, two doors: the CSS presets are the same in both entries.
    expect(motion.interaction).toBe(ui.interaction);
  });

  it('keeps the Motion runtime out of the core entry point', () => {
    const offenders = sourceFiles(join(root, 'src'))
      .filter((f) => !relative(join(root, 'src'), f).startsWith('motion/'))
      .filter((f) =>
        /from 'motion\/react'|from '\.\.\/motion(\/index)?'/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(root, 'src/motion/presets.ts'), 'utf8')).not.toMatch(/from 'motion/);
    expect(pkg.peerDependencies).toHaveProperty('motion');
    expect(pkg.dependencies).not.toHaveProperty('motion');
  });

  it('never imports application or backend code', () => {
    const offenders = sourceFiles(join(root, 'src')).filter((f) =>
      /from '(@wayora\/(api|web|database|worker)|\.\.\/\.\.\/\.\.\/apps)/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
