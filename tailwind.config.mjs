/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{astro,html,js,ts}', './public/**/*.js'],
	theme: {
		extend: {
			colors: {
				border: 'hsl(217.2 32.6% 17.5%)',
				input: 'hsl(217.2 32.6% 17.5%)',
				ring: 'hsl(224.3 76.3% 48%)',
				background: 'hsl(222.2 84% 4.9%)',
				foreground: 'hsl(210 40% 98%)',
				primary: { DEFAULT: 'hsl(0 84.2% 60.2%)', foreground: 'hsl(210 40% 98%)' },
				secondary: { DEFAULT: 'hsl(217.2 32.6% 17.5%)', foreground: 'hsl(210 40% 98%)' },
				muted: { DEFAULT: 'hsl(217.2 32.6% 17.5%)', foreground: 'hsl(215 20.2% 65.1%)' },
				accent: { DEFAULT: 'hsl(217.2 32.6% 17.5%)', foreground: 'hsl(210 40% 98%)' },
				destructive: { DEFAULT: 'hsl(0 62.8% 30.6%)', foreground: 'hsl(210 40% 98%)' },
				card: { DEFAULT: 'hsl(222.2 84% 4.9%)', foreground: 'hsl(210 40% 98%)' },
				popover: { DEFAULT: 'hsl(222.2 84% 4.9%)', foreground: 'hsl(210 40% 98%)' },
			},
			borderRadius: {
				lg: '0.5rem',
				md: 'calc(0.5rem - 2px)',
				sm: 'calc(0.5rem - 4px)',
			},
			keyframes: {
				'pulse-dot': {
					'0%, 100%': { opacity: '1' },
					'50%': { opacity: '0.3' },
				},
			},
			animation: {
				'pulse-dot': 'pulse-dot 1.2s ease-in-out infinite',
			},
		},
	},
	plugins: [],
}
