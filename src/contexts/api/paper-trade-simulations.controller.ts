import { BadRequestException, Controller, Get, Inject, NotFoundException, Param } from "@nestjs/common";
import { OpportunityReadService, PaperTradeSimulationReadService } from "./read-models";

@Controller("v1/opportunities")
export class PaperTradeSimulationsController {
  constructor(
    @Inject(OpportunityReadService) private readonly opportunities: OpportunityReadService,
    @Inject(PaperTradeSimulationReadService) private readonly paperTradeSimulations: PaperTradeSimulationReadService
  ) {}

  @Get(":id/paper-trades")
  async listByOpportunityId(@Param("id") id: string) {
    if (!isUuid(id)) {
      throw new BadRequestException("Opportunity id must be a UUID");
    }

    const opportunity = await this.opportunities.getOpportunity(id);
    if (!opportunity) {
      throw new NotFoundException(`Opportunity ${id} not found`);
    }

    return this.paperTradeSimulations.listPaperTradeSimulations(id);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
