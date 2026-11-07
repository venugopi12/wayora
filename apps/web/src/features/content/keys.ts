/** Public content isn't per-user: its keys live outside `account`. */
export const contentKeys = {
  all: ['content'] as const,
  entry: (section: string, slug: string) => ['content', 'entry', section, slug] as const,
  list: (params: object) => ['content', 'list', params] as const,
  popular: ['content', 'popular'] as const,
};
