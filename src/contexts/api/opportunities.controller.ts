import { BadRequestException, Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { OpportunityReadService } from "./read-models";

@Controller("v1/opportunities")
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunityReadService) {}

  @Get()
  list() {
    return this.opportunities.listOpportunities();
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
