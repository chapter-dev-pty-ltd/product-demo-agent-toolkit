import type { Film } from '../film.ts'
import type { Footage } from '../perform.ts'
import type { TimelineData } from '../../studio/api.ts'
import { highlightsOf, videoLength } from './cut.ts'
import { shownEdits, stepAt, type Edit } from './edits.ts'
import type { Hold } from '../../studio/time.ts'
import { label } from './stage.ts'

// What the studio's timeline draws: the recording as it was taken, with the edits laid over it.
export function timelineOf(
  recorded: Footage,
  film: Film,
  edits: Edit[],
  holds: Hold[] = [],
): TimelineData {
  const start = recorded.frames[0]?.at ?? 0
  return {
    length: videoLength(recorded),
    addresses: (recorded.addresses ?? []).map((a) => ({ at: a.at - start, label: label(a.url) })),
    clicks: recorded.clicks.map((c) => {
      const step = stepAt(recorded, c.at)
      return { at: c.at - start, ...(step === undefined ? {} : { step }), muted: !!c.muted }
    }),
    highlights: highlightsOf(film, recorded).map((h) => ({
      ...h,
      at: h.at - start,
      until: h.until - start,
    })),
    edits: shownEdits(edits),
    holds,
  }
}
