//  @ts-check

/** @type {import('prettier').Config} */
const config = {
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindStylesheet: './apps/web/src/styles.css',
  tailwindFunctions: ['cn', 'cva'],
}

export default config
