/**
 * A new deal's name until someone types one: `<Company> — <Stage label>`.
 * Empty while no company is picked, since a deal is named by its company;
 * the company alone when the stage has no label.
 */
export function composeDealName(company: string, stageLabel: string): string {
  const who = company.trim()
  if (who === '') return ''
  const stage = stageLabel.trim()
  return stage === '' ? who : `${who} — ${stage}`
}
