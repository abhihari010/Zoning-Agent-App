/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        clay: "#d97855",
        pine: "#17342b",
        mist: "#f4efe5",
      },
      boxShadow: {
        card: "0 16px 40px rgba(23, 52, 43, 0.15)",
      },
      fontFamily: {
        heading: ["Poppins", "Segoe UI", "sans-serif"],
        body: ["Manrope", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
