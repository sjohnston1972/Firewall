/** @type {import('tailwindcss').Config} */
export default {
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Dark technical palette
        ink: {
          950: "#0a0c10",
          900: "#0e1117",
          800: "#151a22",
          700: "#1c232e",
          600: "#27303d",
          500: "#3a4656",
        },
        accent: {
          DEFAULT: "#4f9cf9",
          soft: "#1e3a5f",
        },
        good: "#34d399",
        warn: "#fbbf24",
        bad: "#f87171",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
