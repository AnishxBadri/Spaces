---
name: Spaces
description: Self-hosted deal-management OS for angel and private-capital investing
colors:
  paper: '#ffffff'
  bone: '#f4f3ef'
  bone-deep: '#e9e7e1'
  hairline: '#1c1c1a'
  rule: '#d6d4cd'
  graphite: '#5c5b56'
  ink: 'oklch(0.24 0.012 155)'
  pine: 'oklch(0.55 0.14 155)'
  pine-hover: 'oklch(0.5 0.14 155)'
  selected-wash: 'oklch(0.962 0.022 155)'
  destructive-crimson: 'oklch(0.48 0.17 12)'
  success-teal: 'oklch(0.55 0.09 190)'
  warning-amber: 'oklch(0.7 0.13 75)'
  info-blue: 'oklch(0.55 0.1 240)'
typography:
  display:
    fontFamily: 'IBM Plex Serif, Georgia, serif'
    fontSize: '1.75rem'
    fontWeight: 600
    lineHeight: '2rem'
    letterSpacing: '-0.01em'
  section:
    fontFamily: 'IBM Plex Serif, Georgia, serif'
    fontSize: '1.125rem'
    fontWeight: 600
    lineHeight: '1.375rem'
  prose:
    fontFamily: 'IBM Plex Serif, Georgia, serif'
    fontSize: '1.0625rem'
    fontWeight: 400
    lineHeight: '1.6875rem'
  title:
    fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.9375rem'
    fontWeight: 500
    lineHeight: '1.375rem'
  ui:
    fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.8125rem'
    fontWeight: 400
    lineHeight: '1.25rem'
  readout:
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace'
    fontSize: '1.25rem'
    fontWeight: 500
    lineHeight: '1.5rem'
  numeral:
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace'
    fontSize: '0.8125rem'
    fontWeight: 400
    lineHeight: '1rem'
  label:
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace'
    fontSize: '0.6875rem'
    fontWeight: 500
    lineHeight: '1rem'
    letterSpacing: '0.08em'
rounded:
  none: '0px'
  control: '2px'
spacing:
  row: '2.25rem'
components:
  button-primary:
    backgroundColor: '{colors.pine}'
    textColor: '#ffffff'
    rounded: '{rounded.control}'
    padding: '0 12px'
    height: '32px'
  button-primary-hover:
    backgroundColor: '{colors.pine-hover}'
  button-outline:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    borderColor: '{colors.hairline}'
    rounded: '{rounded.control}'
    padding: '0 12px'
    height: '32px'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    height: '32px'
  input:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    borderColor: '{colors.rule}'
    rounded: '{rounded.control}'
    padding: '0 10px'
    height: '32px'
---

# Spaces design tokens

The front matter above is Instrument's tokens, for design tools that read a `DESIGN.md`.
`apps/web/src/styles.css` is where the values live. The rules, the primitives and the
review checklist are in [`docs/design-contract.md`](docs/design-contract.md): read that
before building a surface.
