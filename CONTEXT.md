# Fareloch domain glossary

Terms used across the server, guest mode and the views. The Nutrition module (`server/src/nutrition.ts`) owns every calculation named here.

- **Macros**: the calories, carbs, protein and fat of one quantity of food, as a single value (`Macros` in the Nutrition module).
- **Per-serving nutrition**: a recipe's Macros divided by its total servings; from Manual macros when set, otherwise from its ingredients. A total servings of 0 or blank counts as 1.
- **Manual macros**: whole-recipe Macros entered by hand, overriding the ingredient sum. Blank manual grams count as 0.
- **Unit scale**: how many default servings one household measure is (measure gram weight / food serving size).
- **Stored rounding / Display rounding**: 0.1 for every field (what `meal_logs` holds) / whole kcal and 0.1 g (what recipe `perServing` and the modals show).
