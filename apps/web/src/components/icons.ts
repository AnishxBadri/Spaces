/**
 * The one icon list. Every IBM Carbon glyph in the app is imported here and
 * nowhere else, so a verb draws the same icon on every surface.
 * - `icon` maps each verb to its one glyph: a control that does a verb
 *   reads its icon from here by the verb's name. The verb glyphs are not
 *   exported by their Carbon names, so a call site cannot pick another.
 * - The nouns below (objects, nav pages, attribute types, file and thread
 *   kinds) and a few drawing glyphs (chevrons, the check) are exported by
 *   name; `Link2` is both the link noun and the Copy link verb.
 * - Carbon glyphs are filled shapes on a 32px grid: they draw at 16px
 *   unless a `size-*` class says 20, and take no stroke props.
 * - Our own concepts are not Carbon's: the note kinds are `NoteKindIcon`,
 *   drawn on the same 32-grid; a brand is `ProviderMark`.
 * - `KIND_ICONS` is the one map from an entity kind to its glyph.
 */
import {
  Add,
  Archive,
  ArrowDownRight,
  ArrowLeft,
  ArrowsHorizontal,
  ArrowsVertical,
  At,
  Attachment,
  Book,
  Building,
  Calendar as CarbonCalendar,
  Chat,
  ChatOperational,
  Checkbox,
  CheckboxChecked,
  Checkmark,
  CheckmarkOutline,
  ChevronDown as CarbonChevronDown,
  ChevronRight as CarbonChevronRight,
  ChevronSort,
  Close,
  Column,
  ColumnInsert,
  Compass as CarbonCompass,
  Copy,
  CubeView,
  Currency,
  Document,
  DocumentBlank,
  DocumentImport,
  Download,
  Earth,
  Edit,
  Email,
  Event,
  Filter,
  Finance,
  Flag as CarbonFlag,
  FolderMoveTo,
  Hashtag,
  Image as CarbonImage,
  Launch,
  Layers as CarbonLayers,
  Link as CarbonLink,
  List as CarbonList,
  ListChecked,
  Locked,
  Logout,
  MagicWand,
  MailAll,
  Menu,
  MisuseOutline,
  Money,
  Notebook,
  OverflowMenuHorizontal,
  Paragraph,
  Partnership,
  Pen,
  Phone as CarbonPhone,
  Portfolio,
  Reset,
  Rocket as CarbonRocket,
  Rss as CarbonRss,
  Search,
  Settings as CarbonSettings,
  Star as CarbonStar,
  Sunrise as CarbonSunrise,
  Table,
  TagGroup,
  Template,
  TextFont,
  TrashCan,
  Upload,
  User as CarbonUser,
  UserMultiple,
  View,
  ViewOff,
  WarningAlt,
} from '@carbon/icons-react'
import type { CarbonIconProps, CarbonIconType } from '@carbon/icons-react'
import { createElement, forwardRef } from 'react'
import { NoteIcon } from './note-kind-icon'

/** An icon from this list, for a prop that takes one. */
export type IconComponent = CarbonIconType

/** What an icon from this list takes. */
export type IconProps = CarbonIconProps

/**
 * Carbon's glyph, stamped `data-icon` with its Carbon name so the DOM (and a
 * test) can tell which glyph drew without reading path data.
 */
function carbon(Glyph: CarbonIconType, name: string): IconComponent {
  const Tagged = forwardRef<SVGSVGElement, CarbonIconProps>(
    function Tagged(props, ref) {
      return createElement(Glyph, { ...props, ref, ...dataIcon(name) })
    },
  )
  Tagged.displayName = name
  return Tagged
}

// A `data-*` key is legal on every SVG element but absent from its props
// type; built apart so the spread above carries it without a cast.
function dataIcon(name: string): Record<'data-icon', string> {
  return { 'data-icon': name }
}

/** One glyph per verb, by the verb's name. */
export const icon = {
  new: carbon(Add, 'add'),
  import: carbon(DocumentImport, 'document--import'),
  filter: carbon(Filter, 'filter'),
  sort: carbon(ArrowsVertical, 'arrows--vertical'),
  columns: carbon(ColumnInsert, 'column--insert'),
  search: carbon(Search, 'search'),
  open: carbon(Launch, 'launch'),
  upload: carbon(Upload, 'upload'),
  download: carbon(Download, 'download'),
  enrich: carbon(MagicWand, 'magic-wand'),
  archive: carbon(Archive, 'archive'),
  restore: carbon(Reset, 'reset'),
  more: carbon(OverflowMenuHorizontal, 'overflow-menu--horizontal'),
  close: carbon(Close, 'close'),
  delete: carbon(TrashCan, 'trash-can'),
  copy: carbon(Copy, 'copy'),
  copyLink: carbon(CarbonLink, 'link'),
  edit: carbon(Edit, 'edit'),
  back: carbon(ArrowLeft, 'arrow--left'),
  acceptAll: carbon(CheckmarkOutline, 'checkmark--outline'),
  merge: carbon(ArrowsHorizontal, 'arrows--horizontal'),
  template: carbon(Template, 'template'),
  fileIn: carbon(FolderMoveTo, 'folder--move-to'),
  void: carbon(MisuseOutline, 'misuse--outline'),
  signOut: carbon(Logout, 'logout'),
  menu: carbon(Menu, 'menu'),
  reveal: carbon(View, 'view'),
  conceal: carbon(ViewOff, 'view--off'),
} as const satisfies Record<string, IconComponent>

// Nouns and drawing glyphs, by name. Two names share a glyph only where they
// mean the same thing: `Link` and `Link2`, `CheckSquare` and `SquareCheck`.
export const AtSign = carbon(At, 'at')
export const BookA = carbon(Book, 'book')
export const BookOpen = carbon(Notebook, 'notebook')
export const Boxes = carbon(CubeView, 'cube-view')
export const Briefcase = carbon(Portfolio, 'portfolio')
export const Building2 = carbon(Building, 'building')
export const Calendar = carbon(CarbonCalendar, 'calendar')
export const CalendarDays = carbon(Event, 'event')
export const Check = carbon(Checkmark, 'checkmark')
export const CheckSquare = carbon(CheckboxChecked, 'checkbox--checked')
export const ChevronDown = carbon(CarbonChevronDown, 'chevron--down')
export const ChevronRight = carbon(CarbonChevronRight, 'chevron--right')
export const ChevronsUpDown = carbon(ChevronSort, 'chevron--sort')
export const Coins = carbon(Currency, 'currency')
export const Compass = carbon(CarbonCompass, 'compass')
export const CornerDownRight = carbon(ArrowDownRight, 'arrow--down-right')
export const File = carbon(DocumentBlank, 'document--blank')
export const FileText = carbon(Document, 'document')
export const FileWarning = carbon(WarningAlt, 'warning--alt')
export const Flag = carbon(CarbonFlag, 'flag')
export const Globe = carbon(Earth, 'earth')
export const HandCoins = carbon(Money, 'money')
export const Handshake = carbon(Partnership, 'partnership')
export const Hash = carbon(Hashtag, 'hashtag')
export const Image = carbon(CarbonImage, 'image')
export const Inbox = carbon(MailAll, 'mail--all')
export const Kanban = carbon(Column, 'column')
export const Landmark = carbon(Finance, 'finance')
export const Layers = carbon(CarbonLayers, 'layers')
export const Link = icon.copyLink
export const Link2 = icon.copyLink
export const List = carbon(CarbonList, 'list')
export const ListChecks = carbon(ListChecked, 'list--checked')
export const Lock = carbon(Locked, 'locked')
export const Mail = carbon(Email, 'email')
export const MessageSquare = carbon(Chat, 'chat')
export const MessageSquareText = carbon(ChatOperational, 'chat--operational')
export const Paperclip = carbon(Attachment, 'attachment')
export const PenLine = carbon(Pen, 'pen')
export const Phone = carbon(CarbonPhone, 'phone')
export const Pilcrow = carbon(Paragraph, 'paragraph')
export const Rocket = carbon(CarbonRocket, 'rocket')
export const Rss = carbon(CarbonRss, 'rss')
export const Settings = carbon(CarbonSettings, 'settings')
export const Square = carbon(Checkbox, 'checkbox')
export const SquareCheck = carbon(CheckboxChecked, 'checkbox--checked')
export const Star = carbon(CarbonStar, 'star')
export const Sunrise = carbon(CarbonSunrise, 'sunrise')
export const Table2 = carbon(Table, 'table')
export const Tags = carbon(TagGroup, 'tag--group')
export const Type = carbon(TextFont, 'text--font')
export const User = carbon(CarbonUser, 'user')
export const Users = carbon(UserMultiple, 'user--multiple')

/**
 * Each entity kind's glyph, wherever a row, a chip or a picker names a
 * record of mixed kinds. A custom record's own glyph is its object's
 * (`objectIcon`); `custom` is the fallback for one whose object is unknown.
 */
export const KIND_ICONS: Readonly<Partial<Record<string, IconComponent>>> = {
  company: Building2,
  person: User,
  deal: Kanban,
  space: Layers,
  note: NoteIcon,
  document: Paperclip,
  custom: Boxes,
  term: BookA,
}
