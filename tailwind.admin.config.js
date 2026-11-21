/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/main/resources/templates/admin/**/*.html',
    './src/main/resources/templates/fragments/admin-layout.html',
    './src/main/resources/static/js/**/*.js',
    '!./src/main/resources/templates/admin/pdf/**/*.html',
  ],
  theme: {
    extend: {
      fontFamily: { sans: ['Outfit', 'sans-serif'] },
      colors: {
        furent: {
          50: '#FFF7F0',
          100: '#FFEDD5',
          200: '#FED7AA',
          300: '#FDBA74',
          400: '#FB923C',
          500: '#E07A3A',
          600: '#C2630F',
          700: '#9A4F0E',
          800: '#7C3F0D',
          900: '#65340E',
        },
        surface: {
          50: '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#71717a',
          600: '#52525b',
          700: '#3f3f46',
          800: '#27272a',
          900: '#18181b',
          950: '#09090b',
        },
      },
      boxShadow: {
        glass: '0 8px 32px 0 rgba(0, 0, 0, 0.05)',
        soft: '0 4px 20px -2px rgba(0, 0, 0, 0.05)',
      },
    },
  },
  plugins: [],
};
