import type Database from 'better-sqlite3';

export function storedRecipes(db: Database.Database) {
  return {
    recipes: db.prepare('SELECT * FROM recipes ORDER BY id').all(),
    ingredients: db.prepare('SELECT * FROM recipe_ingredients ORDER BY id').all(),
  };
}

export function rejectSecondIngredient(db: Database.Database) {
  db.exec(`
    CREATE TEMP TRIGGER reject_second_ingredient BEFORE INSERT ON recipe_ingredients
    WHEN (SELECT count(*) FROM recipe_ingredients WHERE recipe_id = NEW.recipe_id) = 1
    BEGIN SELECT RAISE(ABORT, 'second ingredient rejected'); END;
  `);
}
