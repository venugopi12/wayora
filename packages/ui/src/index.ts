// Brand
export {
  BrandMark,
  BRAND_ROUTE_PATH,
  type BrandMarkProps,
  type BrandMarkTone,
} from './brand/BrandMark';
export { Wordmark, type WordmarkProps } from './brand/Wordmark';
export { BrandLoader, type BrandLoaderProps } from './brand/BrandLoader';

// Foundation
export {
  Button,
  IconButton,
  buttonVariants,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
  type IconButtonProps,
} from './components/Button';
export {
  Field,
  Label,
  useFieldControl,
  type FieldProps,
  type LabelProps,
} from './components/Field';
export { Input, type InputProps } from './components/Input';
export { Textarea, type TextareaProps } from './components/Textarea';
export { Select, type SelectProps, type SelectOption } from './components/Select';
export { Checkbox, Radio, RadioGroup, type RadioGroupProps } from './components/Choice';
export { Badge, type BadgeProps, type BadgeTone } from './components/Badge';
export { Avatar, type AvatarProps } from './components/Avatar';
export { Divider, type DividerProps } from './components/Divider';
export { Tooltip, TooltipProvider, type TooltipProps } from './components/Tooltip';
export {
  MediaFrame,
  mediaAspects,
  type MediaFrameProps,
  type MediaAspect,
  type MediaSource,
} from './components/MediaFrame';
export {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
  type AccordionTriggerProps,
  type AccordionTone,
} from './components/Accordion';
export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  type TabsListProps,
  type TabsTriggerProps,
  type TabsContentProps,
} from './components/Tabs';

// Layout
export { Container, type ContainerProps, type ContainerSize } from './layout/Container';
export { Stack, type StackProps, type Gap } from './layout/Stack';
export { Grid, type GridProps } from './layout/Grid';
export { Section, type SectionProps } from './layout/Section';
export { PageHeader, type PageHeaderProps } from './layout/PageHeader';
export { Eyebrow, type EyebrowProps } from './layout/Eyebrow';
export { Prose } from './layout/Prose';
export { Breadcrumbs, type BreadcrumbsProps, type BreadcrumbItem } from './layout/Breadcrumbs';
export { Surface, type SurfaceProps, type SurfaceTone } from './layout/Surface';
export { Card, type CardProps } from './layout/Card';
export {
  SkipLink,
  NavList,
  NavItem,
  MobileNav,
  type NavItemProps,
  type NavListProps,
  type MobileNavProps,
} from './layout/Navigation';
export {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuTrigger,
  NavigationMenuContent,
  type NavigationMenuProps,
  type NavigationMenuLinkProps,
} from './layout/NavigationMenu';

// Feedback & overlays
export { Spinner, type SpinnerProps } from './feedback/Spinner';
export { Skeleton, type SkeletonProps } from './feedback/Skeleton';
export {
  EmptyState,
  ErrorState,
  type EmptyStateProps,
  type ErrorStateProps,
} from './feedback/States';
export { Alert, type AlertProps, type AlertTone } from './feedback/Alert';
export { ToastProvider, useToast, type ToastOptions, type ToastTone } from './feedback/Toast';
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  type DialogContentProps,
} from './feedback/Dialog';
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  type SheetContentProps,
} from './feedback/Sheet';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from './feedback/DropdownMenu';
export {
  Popover,
  PopoverTrigger,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  type PopoverContentProps,
} from './feedback/Popover';

// Travel
export { PriceDisplay, type PriceDisplayProps } from './travel/PriceDisplay';
export { RatingBadge, ratingLabel, type RatingBadgeProps } from './travel/RatingBadge';
export {
  DestinationCard,
  type DestinationCardProps,
  type DestinationAspect,
} from './travel/DestinationCard';
export {
  DestinationFeatureCard,
  type DestinationFeatureCardProps,
} from './travel/DestinationFeatureCard';
export {
  DestinationImage,
  type DestinationImageProps,
  type DestinationImageSource,
} from './travel/DestinationImage';
export {
  ServiceCategoryCard,
  type ServiceCategoryCardProps,
  type ServiceAvailability,
} from './travel/ServiceCategoryCard';
export {
  TravellerCountDisplay,
  describeTravellers,
  type TravellerCountDisplayProps,
  type TravellerCounts,
} from './travel/TravellerCountDisplay';
export {
  JourneySummary,
  type JourneySummaryProps,
  type JourneyPoint,
  type TransportMode,
} from './travel/JourneySummary';

// Utilities & tokens
export { cn, type ClassValue } from './lib/cn';
export {
  formatMoney,
  formatMoneyParts,
  minorToDecimalString,
  formatDuration,
  type MinorAmount,
} from './lib/format';
export { duration, easing, breakpoints, iconSize, ICON_STROKE } from './lib/tokens';

// Motion class presets (pure CSS, no Motion runtime). The JavaScript motion
// library — variants, Reveal, Parallax, useMotionPreferences — is the
// separate `@wayora/ui/motion` entry point.
export {
  interaction,
  overlayMotion,
  effects,
  type InteractionPreset,
  type OverlayMotionPreset,
  type EffectPreset,
} from './motion/presets';
