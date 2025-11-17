// import { Type } from 'class-transformer';
// import { IsDate, IsNotEmpty, IsString } from 'class-validator';

// export class CreateApplicationDto {
//   @IsNotEmpty()
//   @IsString()
//   appId: string;

//   type: TypeEnum;

//   @IsDate()
//   @Type(() => Date)
//   startDate: Date;

//   @IsDate()
//   @Type(() => Date)
//   endDate: Date;
// }
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export enum AppTypeDto {
  vanilla = 'vanilla',
  react = 'react',
  vue = 'vue',
}

export class CreateApplicationDto {
  @IsEnum(AppTypeDto)
  type: AppTypeDto;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;
}
