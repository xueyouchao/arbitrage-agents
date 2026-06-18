import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import { OpportunityReadService } from "./read-models";
import type { OpportunityFilters, OpportunitySort } from "./read-models";

@Controller("v1/opportunities")
export class OpportunitiesController {
  constructor(@Inject(OpportunityReadService) private readonly opportunities: OpportunityReadService) {}

  @Get()
  list(
    @Query("offset") offset?: string,
    @Query("limit") limit?: string,
    @Query("equivalenceClass") equivalenceClass?: string,
    @Query("minNetEdge") minNetEdge?: string,
    @Query("maxDataStalenessMs") maxDataStalenessMs?: string,
    @Query("resolutionRisk") resolutionRisk?: string,
    @Query("fillRisk") fillRisk?: string,
    @Query("humanReviewFlag") humanReviewFlag?: string,
    @Query("sortBy") sortBy?: string,
    @Query("sortOrder") sortOrder?: string
  ) {
    const parsedOffset = Number(offset);
    const parsedLimit = Number(limit);
    
    const pagination = {
      offset: Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0,
      limit: Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.min(100, Math.floor(parsedLimit)) : 20
    };

    const filters: OpportunityFilters = {};
    if (equivalenceClass === "A" || equivalenceClass === "B" || equivalenceClass === "C" || equivalenceClass === "D") {
      filters.equivalenceClass = equivalenceClass;
    }
    if (minNetEdge !== undefined) {
      const value = parseFloat(minNetEdge);
      if (!isNaN(value)) {
        filters.minNetEdge = value;
      }
    }
    if (maxDataStalenessMs !== undefined) {
      const value = parseInt(maxDataStalenessMs, 10);
      if (!isNaN(value) && value > 0) {
        filters.maxDataStalenessMs = value;
      }
    }
    if (resolutionRisk === "low" || resolutionRisk === "medium" || resolutionRisk === "high") {
      filters.resolutionRisk = resolutionRisk;
    }
    if (fillRisk === "low" || fillRisk === "medium" || fillRisk === "high") {
      filters.fillRisk = fillRisk;
    }
    if (humanReviewFlag === "pending" || humanReviewFlag === "approved" || humanReviewFlag === "rejected") {
      filters.humanReviewFlag = humanReviewFlag;
    }

    const sort: OpportunitySort = {
      field: sortBy === "netEdge" || sortBy === "opportunityAgeMs" || sortBy === "equivalenceClass" ? sortBy : "detectedAt",
      order: sortOrder === "asc" ? "asc" : "desc"
    };

    return this.opportunities.listOpportunities({ pagination, filters, sort });
  }

  @Get(":id")
  async getById(@Param("id") id: string) {
    if (!isUuid(id)) {
      throw new BadRequestException("Opportunity id must be a UUID");
    }

    const opportunity = await this.opportunities.getOpportunity(id);
    if (!opportunity) {
      throw new NotFoundException(`Opportunity ${id} not found`);
    }

    return opportunity;
  }
}

/**
 * Validates a UUID string according to RFC 4122.
 * Accepts all UUID versions (v0-v15) with RFC 4122 variant (8, 9, a, b).
 * Format: xxxxxxxx-xxxx-Vxxx-Nxxx-xxxxxxxxxxxx
 *   - V = version nibble (any hex digit 0-f)
 *   - N = variant nibble (must be 8, 9, a, or b for RFC 4122)
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
