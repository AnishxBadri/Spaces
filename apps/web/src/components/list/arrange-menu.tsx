import { ChevronDown, icon } from '../icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  MenuCheck,
} from '../ui/dropdown-menu'
import { cn } from '#/lib/utils'

/**
 * A list's arrange menu: the toolbar button labelled by its grouping
 * (`By record`), opening `Group` and `Sort`, the current one of each
 * checked. The options and what choosing does are the list's.
 */

export type ArrangeOption<T extends string> = {
  readonly id: T
  readonly label: string
}

export function ArrangeMenu<TGroup extends string, TSort extends string>({
  label,
  groups,
  group,
  onGroup,
  sorts,
  sort,
  onSort,
}: {
  /** The button's words: the grouping, `By record`. */
  label: string
  groups: ReadonlyArray<ArrangeOption<TGroup>>
  group: TGroup
  onGroup: (group: TGroup) => void
  sorts: ReadonlyArray<ArrangeOption<TSort>>
  sort: TSort
  onSort: (sort: TSort) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-tool="arrange"
          className="focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui font-medium whitespace-nowrap text-foreground transition-colors duration-100 ease-out-quart hover:bg-bone data-[state=open]:bg-bone"
        >
          <icon.sort aria-hidden className="size-4" />
          {label}
          <ChevronDown aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-55 p-0">
        <ArrangeGroup
          title="Group"
          options={groups}
          current={group}
          onPick={onGroup}
        />
        <ArrangeGroup
          title="Sort"
          options={sorts}
          current={sort}
          onPick={onSort}
          ruled
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ArrangeGroup<T extends string>({
  title,
  options,
  current,
  onPick,
  ruled = false,
}: {
  title: string
  options: ReadonlyArray<ArrangeOption<T>>
  current: T
  onPick: (id: T) => void
  /** A rule over the band: every band after the first. */
  ruled?: boolean
}) {
  return (
    <>
      <DropdownMenuLabel
        className={cn(
          'flex h-7 items-center border-b border-rule bg-bone px-3 py-0 label-caps font-normal text-graphite',
          ruled && 'border-t',
        )}
      >
        {title}
      </DropdownMenuLabel>
      {options.map((o) => (
        <DropdownMenuItem
          key={o.id}
          data-arrange-option={o.id}
          icon={<MenuCheck checked={o.id === current} />}
          onSelect={() => onPick(o.id)}
          className={cn('h-8 px-3', o.id === current && 'font-medium')}
        >
          {o.label}
        </DropdownMenuItem>
      ))}
    </>
  )
}
