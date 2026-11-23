export const stepsName = (steps: number[]): string => {
  const [first = 0, last = first] = [steps[0], steps.at(-1)]
  return first === last ? `Step ${first + 1}` : `Steps ${first + 1}–${last + 1}`
}
