/**
 * The client shares the server's domain types directly. These are type-only
 * imports, erased at build, so no server code reaches the browser bundle — and
 * a schema change breaks the client at typecheck rather than at runtime.
 */
export type { Person, DocumentField } from "../../server/repos/person.js";
export type { Trip, TripStatus } from "../../server/repos/trip.js";
export type {
  TripMember,
  TripMemberRole,
  TripAccessRole,
} from "../../server/repos/trip-access.js";
export type { Booking, BookingStatus } from "../../server/repos/booking.js";
export type { ItineraryDay } from "../../server/repos/itinerary.js";
export type { TripDuplicateGroup } from "../../server/repos/duplicates.js";
export type { DuplicateReason } from "../../server/dedupe.js";
export type { Role } from "../../server/repos/base.js";
export type { Identity } from "../../server/auth.js";
export type { ChecklistItem } from "../../server/repos/checklist.js";
export type { TripRollup } from "../../server/repos/rollup.js";
export type { CreatePersonInput, UpdatePersonInput } from "../../server/repos/person.js";
export type { CreateTripInput, UpdateTripInput } from "../../server/repos/trip.js";
export type { CreateBookingInput, UpdateBookingInput } from "../../server/repos/booking.js";
export type {
  Card,
  CardPerk,
  CardWithPerks,
  PerkWithStatus,
  PerkKind,
  PerkCadence,
  CreateCardInput,
  UpdateCardInput,
  CreatePerkInput,
  UpdatePerkInput,
} from "../../server/repos/card.js";
export type {
  AiProvider,
  HouseholdSettings,
  UpdateHouseholdSettingsInput,
} from "../../server/repos/household-settings.js";
export type { InboundEmailMetadata } from "../../server/repos/inbound-email.js";
export type { AuditEntry, AuditEvent } from "../../server/repos/audit.js";
export type { InboundEmailDetail } from "../../server/routes/inbound-emails.js";
export type {
  DraftBooking,
  UpdateDraftBookingInput,
} from "../../server/repos/draft-booking.js";
export type { ExtractedBooking } from "../../server/ingest/extracted.js";
export type { CatalogModel } from "../../server/ingest/model-catalog.js";
export type { FileImportResult } from "../../server/routes/imports.js";
export type {
  PendingImportDraft,
  PendingImportDuplicate,
  CreateTripFromDraftsInput,
  ImportReviewResult,
} from "../../server/repos/import-review.js";
export type { BookingSourceArtifact } from "../../server/routes/bookings.js";
export type {
  BookingSubscriptionState,
  NotificationPreferences,
  ReminderMode,
  TimezoneSource,
  UpdateNotificationPreferencesInput,
  UserTimezone,
} from "../../server/repos/notification.js";
export type {
  NotificationSettingsResponse,
  PushDeviceView,
  TestNotificationResult,
} from "../../server/routes/notifications.js";
