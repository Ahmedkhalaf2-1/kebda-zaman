import { IsDateString, IsOptional } from 'class-validator';

/** Shared optional `from`/`to` query filter for all admin report endpoints. See date-range.util.ts for parsing/inclusivity semantics. */
export class ReportDateRangeDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
