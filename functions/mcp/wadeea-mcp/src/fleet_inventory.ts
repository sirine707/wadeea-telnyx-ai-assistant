import { StatefulActor } from "@telnyx/edge-runtime";
import { applyReserve, applyRelease, countAvailable, type StoredReservation } from "./reservation_logic";
import type { ReserveResult, AvailabilityResult } from "./types";

// One actor instance per vehicle category (idFromName(category_id)) — the
// assignment's 4c shape: no constructor, lazy get/put, single-threaded RMW.
export class FleetInventory extends StatefulActor {
  private async load(): Promise<StoredReservation[]> {
    return (await this.ctx.storage.get<StoredReservation[]>("reservations")) ?? [];
  }

  async reserve(bookingId: string, startDate: string, endDate: string, totalUnits: number): Promise<ReserveResult> {
    const { reservations, result } = applyReserve(await this.load(), bookingId, startDate, endDate, totalUnits);
    if (result.ok && !result.idempotent) await this.ctx.storage.put("reservations", reservations);
    return result;
  }

  async release(bookingId: string): Promise<{ ok: boolean }> {
    const { reservations, found } = applyRelease(await this.load(), bookingId);
    if (found) await this.ctx.storage.put("reservations", reservations);
    return { ok: found };
  }

  async checkAvailability(startDate: string, endDate: string, totalUnits: number): Promise<AvailabilityResult> {
    return countAvailable(await this.load(), startDate, endDate, totalUnits);
  }
}
