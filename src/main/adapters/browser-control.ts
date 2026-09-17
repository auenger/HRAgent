/** Adds or removes a transparent input shield without changing page content or Agent script actions. */
export function setBrowserControlShield(doc: Document, humanControl: boolean): boolean {
  const existing = doc.querySelector('[data-agenthr-control-shield]')
  if (humanControl) { existing?.remove(); return false }
  if (existing) return true
  const shield = doc.createElement('div')
  shield.setAttribute('data-agenthr-control-shield', 'agent')
  shield.setAttribute('aria-hidden', 'true')
  shield.setAttribute('style', 'position:fixed;inset:0;z-index:2147483645;background:transparent;pointer-events:auto;cursor:not-allowed;')
  doc.documentElement.appendChild(shield)
  return true
}
