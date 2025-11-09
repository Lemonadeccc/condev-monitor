// import { Module } from '@nestjs/common';
// import { ModuleDefinition } from '@nestjs/core/interfaces/module-definition.interface';

// @Module({})
// export class DatabaseModule {
//   imports:[
//     MongooseModule.forRootAsync({
//       imports: [ConfigModule],
//       inject: [ConfigService],
//       useFactory: async (configService: ConfigService) => ({
//         uri: configService.get('MONGODB_URI'),
//       }),

//     })
//   ]
// }

// export class DatabaseModule {
//   static forFeature(models:ModuleDefinition[]){
//     return MongooseModule.forFeature(models)
//   }
// }
