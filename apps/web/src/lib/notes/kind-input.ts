import { z } from 'zod'
import { noteKind } from '@spaces/db/schema'

/**
 * The note kind a server fn accepts, read off the enum so a label the
 * database refuses is refused at the request instead.
 */
export const noteKindInput = z.enum(noteKind.enumValues)
