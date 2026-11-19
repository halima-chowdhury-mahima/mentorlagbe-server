
export type UserRole = "student" | "tutor" | "admin";

export type UserPlan = "free" | "pro";

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  plan: UserPlan;
  image?: string | null;
  phone?: string;
  bio?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  plan: UserPlan;
}
