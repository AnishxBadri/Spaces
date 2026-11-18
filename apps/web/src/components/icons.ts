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
  ArrowDown as CarbonArrowDown,
  ArrowDownRight,
  ArrowLeft,
  ArrowsHorizontal,
  ArrowsVertical,
  ArrowUp as CarbonArrowUp,
  At,
  Attachment,
  Book,
  Building,
  Calendar as CarbonCalendar,
  Category,
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
  ColorPalette,
  Column,
  ColumnInsert,
  Compass as CarbonCompass,
  Copy,
  CubeView,
  Currency,
  DataRefinery,
  Document,
  DocumentBlank,
  DocumentImport,
  DocumentView,
  Download,
  Earth,
  Edit,
  Email,
  Erase,
  Event,
  Filter,
  Finance,
  Flag as CarbonFlag,
  Folder as CarbonFolder,
  FolderAdd,
  FolderMoveTo,
  Hashtag,
  Image as CarbonImage,
  ImageSearch,
  Keyboard as CarbonKeyboard,
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
  Notification,
  NotificationOff,
  OverflowMenuHorizontal,
  Paragraph,
  Partnership,
  Password,
  Pen,
  Phone as CarbonPhone,
  Pin,
  Play,
  Plug as CarbonPlug,
  Portfolio,
  Power,
  Renew,
  Repeat,
  Reply,
  ReplyAll,
  Reset,
  Rocket as CarbonRocket,
  Rss as CarbonRss,
  Save,
  Search,
  Send,
  Settings as CarbonSettings,
  SortAscending,
  SortDescending,
  Split,
  Star as CarbonStar,
  Sunrise as CarbonSunrise,
  Table,
  TagGroup,
  Template,
  TextFont,
  TextLongParagraph,
  TrashCan,
  Unlink,
  Upload,
  User as CarbonUser,
  UserAccess,
  UserAdmin,
  UserFollow,
  UserMultiple,
  Version,
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
  /** Opens the thing here, in the app. */
  open: carbon(View, 'view'),
  /** Leaves the app (`Open ↗`) for a place with no mark of its own. */
  openOutside: carbon(Launch, 'launch'),
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
  keep: carbon(Save, 'save'),
  fileOn: carbon(FolderAdd, 'folder--add'),
  version: carbon(Version, 'version'),
  access: carbon(UserAccess, 'user--access'),
  unlink: carbon(Unlink, 'unlink'),
  reply: carbon(Reply, 'reply'),
  replyAll: carbon(ReplyAll, 'reply--all'),
  forward: carbon(Send, 'send'),
  invite: carbon(UserFollow, 'user--follow'),
  moveUp: carbon(CarbonArrowUp, 'arrow--up'),
  moveDown: carbon(CarbonArrowDown, 'arrow--down'),
  clear: carbon(Erase, 'erase'),
  sortAscending: carbon(SortAscending, 'sort--ascending'),
  sortDescending: carbon(SortDescending, 'sort--descending'),
  follow: carbon(Notification, 'notification'),
  unfollow: carbon(NotificationOff, 'notification--off'),
  changeKind: carbon(Category, 'category'),
  read: carbon(DocumentView, 'document--view'),
  readVision: carbon(ImageSearch, 'image--search'),
  summarize: carbon(TextLongParagraph, 'text--long-paragraph'),
  extract: carbon(DataRefinery, 'data--refinery'),
  writeUp: carbon(Pen, 'pen'),
  run: carbon(Play, 'play'),
  pin: carbon(Pin, 'pin'),
  role: carbon(UserAdmin, 'user--admin'),
  resetPassword: carbon(Password, 'password'),
  update: carbon(Renew, 'renew'),
  enable: carbon(Power, 'power'),
  color: carbon(ColorPalette, 'color-palette'),
  split: carbon(Split, 'split'),
  /** Swaps the one value a single field holds for another. */
  swap: carbon(Repeat, 'repeat'),
} as const satisfies Record<string, IconComponent>

// Nouns and drawing glyphs, by name. Two names share a glyph only where they
// mean the same thing: `Link` and `Link2`, `CheckSquare` and `SquareCheck`.
export const ArrowDown = carbon(CarbonArrowDown, 'arrow--down')
export const ArrowUp = carbon(CarbonArrowUp, 'arrow--up')
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
export const Folder = carbon(CarbonFolder, 'folder')
export const Globe = carbon(Earth, 'earth')
export const HandCoins = carbon(Money, 'money')
export const Handshake = carbon(Partnership, 'partnership')
export const Hash = carbon(Hashtag, 'hashtag')
export const Image = carbon(CarbonImage, 'image')
export const Keyboard = carbon(CarbonKeyboard, 'keyboard')
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
/** A plugin with no mark of its own, where its action leads a menu item. */
export const Plug = carbon(CarbonPlug, 'plug')
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
