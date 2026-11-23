import type { Film } from '../film.ts'
import type { Footage } from '../perform.ts'
import type { ShownCover, TimelineData } from '../../studio/api.ts'
import { highlightsOf, videoLength } from './cut.ts'
import { shownEdits, stepAt, type Edit } from './edits.ts'
import { label } from './stage.ts'

// What the studio's timeline draws: the recording as it was taken, with the edits laid over it.
export function timelineOf(
  recorded: Footage,
  film: Film,
  edits: Edit[],
  holds: ShownCover[],
): TimelineData {
  const start = recorded.frames[0]?.at ?? 0
  return {
    length: videoLength(recorded),
    // From the take's start at the earliest, where an opening cover goes before it.
    addresses: (recorded.addresses ?? []).map((a) => ({
      at: Math.max(0, a.at - start),
      label: label(a.url),
    })),
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
