
export type ApplicationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "cancelled";

export interface Application {
  _id?: string;
  tuitionId: string;
  studentId: string;
  tutorId: string;
  status: ApplicationStatus;
  message?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
