import { Injectable } from '@nestjs/common';

import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { PrismaService } from './prisma.service';

@Injectable()
export class ApplicationsService {
  constructor(
    // private readonly applicationsRepository: ApplicationsRepository,
    private readonly prismaService: PrismaService,
  ) {}
  create(createApplicationDto: CreateApplicationDto) {
    return this.prismaService.applications.create({
      data: {
        ...createApplicationDto,
        timestamp: new Date(),
        userId: '123',
      },
    });
  }

  findAll() {
    return this.prismaService.applications.findMany({});
  }

  findOne(id: number) {
    return this.prismaService.applications.findUniqueOrThrow({ where: { id } });
  }

  update(id: number, updateApplicationDto: UpdateApplicationDto) {
    return this.prismaService.applications.update({
      where: { id },
      data: updateApplicationDto,
    });
  }

  remove(id: number) {
    return this.prismaService.applications.delete({ where: { id } });
  }
}
