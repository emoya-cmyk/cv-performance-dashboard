/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] },
      colors: {
        // Brand colours are driven by CSS variables so the agency can white-label at runtime.
        // --brand-* are RGB triplets (e.g. "229 57 53") set by applyBrandColor() in agencySettings.js.
        // The <alpha-value> placeholder lets Tailwind's opacity modifiers (e.g. bg-brand-500/20) work correctly.
        brand: {
          50:  'rgb(var(--brand-50)  / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
        },
        navy: {
          800: '#141414',
          900: '#0a0a0a',
        },
      },
    },
  },
  plugins: [],
}
