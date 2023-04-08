import { injectError } from './lib/jsError'
import { injectXHR } from './lib/xhr';
import { blankScreen } from './lib/blankScreen';
import { timing} from './lib/timing'
import {longTask} from './lib/longTask'
injectError();
injectXHR();
blankScreen();
timing();
longTask();
