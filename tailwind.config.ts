import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        go: '#22c55e',
        nogo: '#ef4444',
      },
    },
  },
  plugins: [],
} satisfies Config;
