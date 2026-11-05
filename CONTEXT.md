# Fareloch domain glossary

Terms used across the server, guest mode and the views. The Nutrition module (`server/src/nutrition.ts`) owns the nutrition calculations named here.

- **Macros**: the calories, carbs, protein and fat of one quantity of food, as a single value (`Macros` in the Nutrition module).
- **Per-serving nutrition**: a recipe's Macros divided by its total servings; from Manual macros when set, otherwise from its ingredients. A total servings of 0 or blank counts as 1.
- **Manual macros**: whole-recipe Macros entered by hand, overriding the ingredient sum. Blank manual grams count as 0.
- **Unit scale**: how many default servings one household measure is (measure gram weight / food serving size).
- **Stored rounding / Display rounding**: 0.1 for every field (what `meal_logs` holds) / whole kcal and 0.1 g (what recipe `perServing` and the modals show).
- **Food search session**: the active search for foods within Log Food or a Recipe editor. Its results belong to the latest query in the active mode, and its lifetime ends when the user leaves the view.
- **Log Food session**: The selected date and Meal type, tabs, food and recipe selection, forms, scanner, DOM and pending work owned by one mounted Log Food screen. Its lifetime ends on route departure; only work belonging to that mount may publish or navigate.
- **Recipe editor session**: The draft, ingredient selection, modes, DOM and pending work owned by one mounted Recipe editor. Its lifetime ends on route departure; only work belonging to that mount may publish or navigate.
- **Dashboard date session**: The selected date, meal data, workout state and pending work owned by one mounted Dashboard; only current work for that mount and selection may publish.
- **Weight session**: The forms, weight history, trend and waist comparison, chart, DOM and pending work owned by one mounted Weight screen. Its lifetime ends on route departure; only the newest refresh in the active mount may publish data, and only that mount may publish action feedback.
- **Settings form session**: The Profile, Daily Targets, Workout-Day Targets, Phase Presets, and Change Password forms, their DOM, listeners, and feedback timers owned by one mounted Settings screen. Only that live mount may publish form feedback or mutate its controls; completed profile and target saves retain their existing application user-state publication after departure.
- **Password recovery session**: The Forgot Password or Set New Password form, captured reset token when applicable, DOM, listeners, pending feedback, and delayed login navigation owned by one mount. Its lifetime ends on route departure; only that live mount may publish feedback or view-owned navigation.
