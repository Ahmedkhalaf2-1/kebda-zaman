import { IsIn, IsOptional } from 'class-validator';
import { ReportDateRangeDto } from './report-date-range.dto';

export const SALES_GROUP_BY_VALUES = ['day', 'week', 'month'] as const;
export type SalesGroupBy = (typeof SALES_GROUP_BY_VALUES)[number];

export class SalesTimelineQueryDto extends ReportDateRangeDto {
  @IsOptional()
  @IsIn(SALES_GROUP_BY_VALUES)
  groupBy?: SalesGroupBy = 'day';
}
