import { IsInt, Max, Min } from 'class-validator';

/** Manual kitchen prep time (minutes-to-ready). Preset UI values (10/15/20/30/45)
 * plus any custom value are all just integers in this range — the backend
 * never distinguishes a preset from a custom one. */
export class SetPreparationTimeDto {
  @IsInt()
  @Min(1)
  @Max(180)
  minutes!: number;
}
