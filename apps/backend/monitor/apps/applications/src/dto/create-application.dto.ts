import { IsDate, IsNotEmpty, IsString } from 'class-validator';

export class CreateApplicationDto {
  @IsDate()
  @Type(() => Date)
  startDate: Date;

  @IsDate()
  @Type(() => Date)
  endDate: Date;

  @IsString()
  @IsNotEmpty()
  placeId: string;

  @IsString()
  @IsNotEmpty()
  invoiceId: string;
}
// function Type(
//   arg0: () => DateConstructor,
// ): (target: CreateApplicationDto, propertyKey: 'startDate') => void {
//   throw new Error('Function not implemented.');
// }
