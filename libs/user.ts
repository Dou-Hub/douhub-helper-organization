//  Copyright PrimeObjects Software Inc. and other contributors <https://www.primeobjects.com/>
// 
//  This source code is licensed under the MIT license.
//  The detail information can be found in the LICENSE file in the root directory of this source tree.

import { getPropValueOfObject, isNonEmptyString, isGuid } from 'douhub-helper-util';
import { s3Get } from 'douhub-helper-service';
import { isObject, find, isNil, isBoolean, isNumber, isArray } from 'lodash';
import { checkToken, getToken } from './token';
import {
    HTTPERROR_400, HTTPERROR_429, HTTPERROR_403,
    ERROR_TOO_MANY_REQUESTS, ERROR_AUTH_FAILED,
    S3_BUCKET_NAME_DATA,
    ERROR_PARAMETER_MISSING,
    REGION, SECRET_ID
} from './constants';
import { CheckCallerSettings, CheckCallerResult } from './types';
import { CognitoIdentityServiceProvider, DynamoDB } from 'aws-sdk';
import { getPropValueOfEvent, checkRateLimit } from './helper';
import axios from 'axios';
import { getSecretValue } from 'douhub-helper-service';