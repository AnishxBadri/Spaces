/**
 * The one icon list. Every IBM Carbon glyph in the app is imported here and
 * nowhere else, so a verb draws the same icon on every surface.
 * - `icon` maps each verb to its one glyph: a control that does a verb
 *   reads its icon from here by the verb's name. The verb glyphs are not
 *   exported by their Carbon names, so a call site cannot pick another.
 * - The nouns below (objects, nav pages, attribute types, file and thread
 *   kinds) and a few drawing glyphs (chevrons, the checkmark, the sort
 *   arrows) are exported by their Carbon names, as the contract names them
 *   (company `Building`, deal `Column`). Where Carbon's name is already a
 *   global or an app component's, the noun takes a plain name: `Page` for
 *   Carbon's `Document`, `Meeting` for `Event`, `Square` for `Checkbox`.
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
  ArrowDownRight as CarbonArrowDownRight,
  ArrowLeft,
  ArrowsHorizontal,
  ArrowsVertical,
  ArrowUp as CarbonArrowUp,
  Attachment as CarbonAttachment,
  Book as CarbonBook,
  Building as CarbonBuilding,
  Calendar as CarbonCalendar,
  Category,
  Chat as CarbonChat,
  ChatOperational as CarbonChatOperational,
  Checkbox,
  CheckboxChecked as CarbonCheckboxChecked,
  Checkmark as CarbonCheckmark,
  CheckmarkOutline,
  ChevronDown as CarbonChevronDown,
  ChevronLeft as CarbonChevronLeft,
  ChevronRight as CarbonChevronRight,
  ChevronSort as CarbonChevronSort,
  Close,
  ColorPalette,
  Column as CarbonColumn,
  ColumnInsert,
  Compass as CarbonCompass,
  Copy,
  CubeView as CarbonCubeView,
  Currency as CarbonCurrency,
  DataRefinery,
  Document as CarbonDocument,
  DocumentBlank as CarbonDocumentBlank,
  DocumentImport,
  DocumentView,
  Download,
  Earth as CarbonEarth,
  Edit,
  Email as CarbonEmail,
  Erase,
  Event,
  Filter,
  Finance as CarbonFinance,
  Flag as CarbonFlag,
  Folder as CarbonFolder,
  FolderAdd,
  FolderMoveTo,
  Hashtag as CarbonHashtag,
  Image as CarbonImage,
  ImageSearch,
  Keyboard as CarbonKeyboard,
  Laptop as CarbonLaptop,
  Launch,
  Layers as CarbonLayers,
  Link as CarbonLink,
  List as CarbonList,
  Locked as CarbonLocked,
  Logout,
  MagicWand,
  Maximize,
  MailAll as CarbonMailAll,
  Menu,
  MisuseOutline,
  Money as CarbonMoney,
  Notebook as CarbonNotebook,
  Notification,
  NotificationOff,
  OverflowMenuHorizontal,
  Paragraph as CarbonParagraph,
  Partnership as CarbonPartnership,
  Password,
  Pen,
  Phone as CarbonPhone,
  Pin,
  Play,
  Plug as CarbonPlug,
  Portfolio as CarbonPortfolio,
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
  Subtract,
  Star as CarbonStar,
  Sunrise as CarbonSunrise,
  Table as CarbonTable,
  TagGroup as CarbonTagGroup,
  Template,
  TextFont as CarbonTextFont,
  Time as CarbonTime,
  TextLongParagraph,
  TrashCan,
  Unlink,
  Upload,
  User as CarbonUser,
  UserAccess,
  UserAdmin,
  UserFollow,
  UserMultiple as CarbonUserMultiple,
  Version,
  Video as CarbonVideo,
  View,
  ViewOff,
  WarningAlt as CarbonWarningAlt,
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
  /** A window's thing opened as its own page, in the app. */
  openAsPage: carbon(Maximize, 'maximize'),
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
  unfile: carbon(Subtract, 'subtract'),
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

// Nouns and drawing glyphs, by Carbon's name. `Link` is the Copy link verb's
// glyph too: a link is the same thing in both.
export const ArrowDown = carbon(CarbonArrowDown, 'arrow--down')
export const ArrowDownRight = carbon(CarbonArrowDownRight, 'arrow--down-right')
export const ArrowUp = carbon(CarbonArrowUp, 'arrow--up')
export const Attachment = carbon(CarbonAttachment, 'attachment')
export const Book = carbon(CarbonBook, 'book')
export const Building = carbon(CarbonBuilding, 'building')
export const Calendar = carbon(CarbonCalendar, 'calendar')
export const Chat = carbon(CarbonChat, 'chat')
export const ChatOperational = carbon(
  CarbonChatOperational,
  'chat--operational',
)
export const CheckboxChecked = carbon(
  CarbonCheckboxChecked,
  'checkbox--checked',
)
export const Checkmark = carbon(CarbonCheckmark, 'checkmark')
export const ChevronDown = carbon(CarbonChevronDown, 'chevron--down')
export const ChevronLeft = carbon(CarbonChevronLeft, 'chevron--left')
export const ChevronRight = carbon(CarbonChevronRight, 'chevron--right')
export const ChevronSort = carbon(CarbonChevronSort, 'chevron--sort')
export const Column = carbon(CarbonColumn, 'column')
export const Compass = carbon(CarbonCompass, 'compass')
export const CubeView = carbon(CarbonCubeView, 'cube-view')
export const Currency = carbon(CarbonCurrency, 'currency')
export const DocumentBlank = carbon(CarbonDocumentBlank, 'document--blank')
export const Earth = carbon(CarbonEarth, 'earth')
export const Email = carbon(CarbonEmail, 'email')
export const Finance = carbon(CarbonFinance, 'finance')
export const Flag = carbon(CarbonFlag, 'flag')
export const Folder = carbon(CarbonFolder, 'folder')
export const Hashtag = carbon(CarbonHashtag, 'hashtag')
export const Image = carbon(CarbonImage, 'image')
export const Keyboard = carbon(CarbonKeyboard, 'keyboard')
export const Laptop = carbon(CarbonLaptop, 'laptop')
export const Layers = carbon(CarbonLayers, 'layers')
export const Link = icon.copyLink
export const List = carbon(CarbonList, 'list')
export const Locked = carbon(CarbonLocked, 'locked')
export const MailAll = carbon(CarbonMailAll, 'mail--all')
/** Carbon's `Event`, named for what it marks: the global `Event` is taken. */
export const Meeting = carbon(Event, 'event')
export const Money = carbon(CarbonMoney, 'money')
export const Notebook = carbon(CarbonNotebook, 'notebook')
/** Carbon's `Document`, a page of text: the global `Document` is taken. */
export const Page = carbon(CarbonDocument, 'document')
export const Paragraph = carbon(CarbonParagraph, 'paragraph')
export const Partnership = carbon(CarbonPartnership, 'partnership')
export const Phone = carbon(CarbonPhone, 'phone')
/** A plugin with no mark of its own, where its action leads a menu item. */
export const Plug = carbon(CarbonPlug, 'plug')
export const Portfolio = carbon(CarbonPortfolio, 'portfolio')
export const Rocket = carbon(CarbonRocket, 'rocket')
export const Rss = carbon(CarbonRss, 'rss')
export const Settings = carbon(CarbonSettings, 'settings')
/** Carbon's empty `Checkbox`, a bare square: `Checkbox` is the control's. */
export const Square = carbon(Checkbox, 'checkbox')
export const Star = carbon(CarbonStar, 'star')
export const Sunrise = carbon(CarbonSunrise, 'sunrise')
export const Table = carbon(CarbonTable, 'table')
export const TagGroup = carbon(CarbonTagGroup, 'tag--group')
export const TextFont = carbon(CarbonTextFont, 'text--font')
export const Time = carbon(CarbonTime, 'time')
export const User = carbon(CarbonUser, 'user')
/** A meeting's call link: the camera on an agenda row. */
export const Video = carbon(CarbonVideo, 'video')
export const UserMultiple = carbon(CarbonUserMultiple, 'user--multiple')
export const WarningAlt = carbon(CarbonWarningAlt, 'warning--alt')

/**
 * Each entity kind's glyph, wherever a row, a chip or a picker names a
 * record of mixed kinds. A custom record's own glyph is its object's
 * (`objectIcon`); `custom` is the fallback for one whose object is unknown.
 */
export const KIND_ICONS: Readonly<Partial<Record<string, IconComponent>>> = {
  company: Building,
  person: User,
  deal: Column,
  space: Layers,
  note: NoteIcon,
  document: Attachment,
  custom: CubeView,
  term: Book,
}
