import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReportsService } from './reports.service';
import { ReportDateRangeDto } from './dto/report-date-range.dto';
import { SalesTimelineQueryDto } from './dto/sales-timeline-query.dto';
import { TopItemsQueryDto } from './dto/top-items-query.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/reports', version: '1' })
export class AdminReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('overview')
  overview(@Query() query: ReportDateRangeDto) {
    return this.reportsService.getOverview(query);
  }

  @Get('sales')
  sales(@Query() query: SalesTimelineQueryDto) {
    return this.reportsService.getSalesTimeline(query);
  }

  @Get('orders')
  orders(@Query() query: ReportDateRangeDto) {
    return this.reportsService.getOrderBreakdown(query);
  }

  @Get('top-items')
  topItems(@Query() query: TopItemsQueryDto) {
    return this.reportsService.getTopItems(query);
  }
}
