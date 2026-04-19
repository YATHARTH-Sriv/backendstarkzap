import type { Pool } from "pg";

export type OnboardingStep = "welcome" | "username" | "wallet" | "done";

export type UserProfileRecord = {
  privyUserId: string;
  username: string | null;
  onboardingStep: OnboardingStep;
  onboardingCompleted: boolean;
  onboardingCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface UserProfileRepository {
  ensureUser(privyUserId: string): Promise<void>;
  getByPrivyUserId(privyUserId: string): Promise<UserProfileRecord | null>;
  setUsername(privyUserId: string, username: string): Promise<UserProfileRecord>;
  setOnboardingStep(privyUserId: string, step: OnboardingStep): Promise<UserProfileRecord>;
  markOnboardingComplete(privyUserId: string): Promise<UserProfileRecord>;
}

type UserProfileRow = {
  privy_user_id: string;
  username: string | null;
  onboarding_step: string;
  onboarding_completed: boolean;
  onboarding_completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toOnboardingStep(rawStep: string): OnboardingStep {
  if (rawStep === "welcome" || rawStep === "username" || rawStep === "wallet" || rawStep === "done") {
    return rawStep;
  }

  return "welcome";
}

function mapRow(row: UserProfileRow): UserProfileRecord {
  return {
    privyUserId: row.privy_user_id,
    username: row.username,
    onboardingStep: toOnboardingStep(row.onboarding_step),
    onboardingCompleted: row.onboarding_completed,
    onboardingCompletedAt: row.onboarding_completed_at ? row.onboarding_completed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createUserProfileRepository(db: Pool): UserProfileRepository {
  async function ensureUser(privyUserId: string): Promise<void> {
    await db.query(
      `
        INSERT INTO app_users (privy_user_id, updated_at)
        VALUES ($1, NOW())
        ON CONFLICT (privy_user_id)
        DO UPDATE SET updated_at = NOW()
      `,
      [privyUserId],
    );
  }

  async function getByPrivyUserId(privyUserId: string): Promise<UserProfileRecord | null> {
    const result = await db.query<UserProfileRow>(
      `
        SELECT
          privy_user_id,
          username,
          onboarding_step,
          onboarding_completed,
          onboarding_completed_at,
          created_at,
          updated_at
        FROM app_users
        WHERE privy_user_id = $1
        LIMIT 1
      `,
      [privyUserId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async function setUsername(privyUserId: string, username: string): Promise<UserProfileRecord> {
    await ensureUser(privyUserId);

    const result = await db.query<UserProfileRow>(
      `
        UPDATE app_users
        SET
          username = $2,
          onboarding_step = CASE
            WHEN onboarding_completed THEN onboarding_step
            ELSE 'wallet'
          END,
          updated_at = NOW()
        WHERE privy_user_id = $1
        RETURNING
          privy_user_id,
          username,
          onboarding_step,
          onboarding_completed,
          onboarding_completed_at,
          created_at,
          updated_at
      `,
      [privyUserId, username],
    );

    return mapRow(result.rows[0]);
  }

  async function setOnboardingStep(privyUserId: string, step: OnboardingStep): Promise<UserProfileRecord> {
    await ensureUser(privyUserId);

    const result = await db.query<UserProfileRow>(
      `
        UPDATE app_users
        SET
          onboarding_step = $2,
          updated_at = NOW()
        WHERE privy_user_id = $1
        RETURNING
          privy_user_id,
          username,
          onboarding_step,
          onboarding_completed,
          onboarding_completed_at,
          created_at,
          updated_at
      `,
      [privyUserId, step],
    );

    return mapRow(result.rows[0]);
  }

  async function markOnboardingComplete(privyUserId: string): Promise<UserProfileRecord> {
    await ensureUser(privyUserId);

    const result = await db.query<UserProfileRow>(
      `
        UPDATE app_users
        SET
          onboarding_step = 'done',
          onboarding_completed = TRUE,
          onboarding_completed_at = NOW(),
          updated_at = NOW()
        WHERE privy_user_id = $1
        RETURNING
          privy_user_id,
          username,
          onboarding_step,
          onboarding_completed,
          onboarding_completed_at,
          created_at,
          updated_at
      `,
      [privyUserId],
    );

    return mapRow(result.rows[0]);
  }

  return {
    ensureUser,
    getByPrivyUserId,
    setUsername,
    setOnboardingStep,
    markOnboardingComplete,
  };
}
