import type Database from 'better-sqlite3';
import { isWaistInches } from './waist.js';

export interface Profile {
  id: number;
  email: string;
  firstName: string;
  emailVerified: boolean;
  heightInches: number | null;
  currentWeightLbs: number | null;
  targetWaistInches: number | null;
  targetCalories: number | null;
  targetCarbsG: number | null;
  targetProteinG: number | null;
  targetFatG: number | null;
  workoutTargetCalories: number | null;
  workoutTargetCarbsG: number | null;
  workoutTargetProteinG: number | null;
  workoutTargetFatG: number | null;
}

interface ProfileChanges {
  firstName?: string | null;
  heightInches?: number | null;
  currentWeightLbs?: number | null;
  targetWaistInches?: unknown;
  targetCalories?: number | null;
  targetCarbsG?: number | null;
  targetProteinG?: number | null;
  targetFatG?: number | null;
  workoutTargetCalories?: number | null;
  workoutTargetCarbsG?: number | null;
  workoutTargetProteinG?: number | null;
  workoutTargetFatG?: number | null;
}

type ProfileRow = Omit<Profile, 'emailVerified'> & { emailVerified: number | null };

type ProfileUpdate =
  | { kind: 'updated'; profile: Profile }
  | { kind: 'invalid-waist' }
  | { kind: 'missing' };

export function readProfile(db: Database.Database, userId: number): Profile | undefined {
  const row = db.prepare(`
    SELECT id, email, first_name AS firstName, email_verified AS emailVerified,
      height_inches AS heightInches, current_weight_lbs AS currentWeightLbs,
      target_waist_inches AS targetWaistInches,
      target_calories AS targetCalories, target_carbs_g AS targetCarbsG,
      target_protein_g AS targetProteinG, target_fat_g AS targetFatG,
      workout_target_calories AS workoutTargetCalories, workout_target_carbs_g AS workoutTargetCarbsG,
      workout_target_protein_g AS workoutTargetProteinG, workout_target_fat_g AS workoutTargetFatG
    FROM users WHERE id = ?
  `).get(userId) as ProfileRow | undefined;
  return row ? { ...row, emailVerified: !!row.emailVerified } : undefined;
}

export function updateProfile(db: Database.Database, userId: number, input: ProfileChanges): ProfileUpdate {
  const {
    firstName, heightInches, currentWeightLbs, targetWaistInches,
    targetCalories, targetCarbsG, targetProteinG, targetFatG,
    workoutTargetCalories, workoutTargetCarbsG, workoutTargetProteinG, workoutTargetFatG,
  } = input;
  if (targetWaistInches != null && !isWaistInches(targetWaistInches)) {
    return { kind: 'invalid-waist' };
  }
  db.prepare(`
    UPDATE users SET
      first_name = COALESCE(?, first_name),
      height_inches = COALESCE(?, height_inches),
      current_weight_lbs = COALESCE(?, current_weight_lbs),
      target_waist_inches = CASE WHEN ? THEN ? ELSE target_waist_inches END,
      target_calories = COALESCE(?, target_calories),
      target_carbs_g = COALESCE(?, target_carbs_g),
      target_protein_g = COALESCE(?, target_protein_g),
      target_fat_g = COALESCE(?, target_fat_g),
      workout_target_calories = COALESCE(?, workout_target_calories),
      workout_target_carbs_g = COALESCE(?, workout_target_carbs_g),
      workout_target_protein_g = COALESCE(?, workout_target_protein_g),
      workout_target_fat_g = COALESCE(?, workout_target_fat_g)
    WHERE id = ?
  `).run(
    firstName, heightInches, currentWeightLbs,
    targetWaistInches !== undefined ? 1 : 0, targetWaistInches ?? null,
    targetCalories, targetCarbsG, targetProteinG, targetFatG,
    workoutTargetCalories, workoutTargetCarbsG, workoutTargetProteinG, workoutTargetFatG,
    userId
  );
  const profile = readProfile(db, userId);
  return profile ? { kind: 'updated', profile } : { kind: 'missing' };
}
