//  Copyright PrimeObjects Software Inc. and other contributors <https://www.primeobjects.com/>
// 
//  This source code is licensed under the MIT license.
//  The detail information can be found in the LICENSE file in the root directory of this source tree.


import {
    S3_BUCKET_NAME_DATA, cosmosDBDelete,
    cosmosDBQuery, cosmosDBRetrieveById, cosmosDBUpdate,
    createCognitoUser, updateCognitoPassword,
    dynamoDBCreate,
    dynamoDBDelete,
    dynamoDBUpsert,
    DYNAMO_DB_TABLE_NAME_PROFILE,
    s3Get, sendEmail
} from 'douhub-helper-service';

import {
    isNonEmptyString, newGuid, utcISOString, _track,
    isEmail, isPhoneNumber, isPassword, serialNumber, isObject,
    checkEntityPrivilege, hasRole, getRecordEmailAddress, isGuid
} from 'douhub-helper-util';

import { assign, find, isNil, isArray, isNumber, map, cloneDeep } from 'lodash';

import {
    createToken,
    HTTPERROR_400, ERROR_PARAMETER_MISSING,
    encryptToken, HTTPERROR_403,
    ERROR_PARAMETER_INVALID,
    ERROR_PERMISSION_DENIED
} from "douhub-helper-lambda";

import { createRecord, processUpsertData, updateRecord, processContent } from 'douhub-helper-data';

export const processCreateUserRequests = (context: Record<string, any>, signUp:boolean, apiName: string) => {

    const { user, solution } = context;

    const solutionId = solution?.id;
    const organizationId = user?.organizationId;
    const userId = user?.id;
    const auth = solution?.auth;
    const cognito = auth?.cognito;

    if (!isObject(cognito)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source: apiName,
            detail: {
                reason: 'The context.solution.cognito does not exist.',
                parameters: { solution }
            }
        }
    }

    if (isNil(organizationId) && !signUp) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source: apiName,
            detail: {
                reason: 'The context.user.organizationId does not exist.',
                parameters: { user }
            }
        }
    }

    if (!(hasRole(context, 'ORG-ADMIN') || hasRole(context, 'USER-MANAGER')) && !signUp) {
        throw {
            ...HTTPERROR_403,
            type: ERROR_PERMISSION_DENIED,
            source: apiName,
            detail: {
                reason: 'The caller has no permission to create a user. (the ORG-ADMIN or USER-MANAGER role is required.)'
            }
        }
    }

    const { userPoolLambdaClientId, userPoolId, passwordRules } = cognito;
    return { userId, organizationId, solutionId, userPoolId, userPoolLambdaClientId, passwordRules };
}

/*
Get the user organizations based on mobile number or email
Return all organizations user belong to. 
If there are more than one organizations for a user, the UI should ask user to choose one
*/
export const getUserOrgs = async (value: string, type: 'email' | 'mobile'): Promise<Record<string, any>> => {

    const source = 'getUserOrgs';

    if (type == 'email' && !isEmail(value)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'email',
                parameters: { value }
            }
        }
    }

    if (type == 'mobile' && !isPhoneNumber(value)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'email',
                parameters: { value }
            }
        }
    }


    const attributes = 'c.id, c.organizationId, c.emailVerifiedOn, c.mobileVerifiedOn, c.stateCode, c.statusCode, c.latestSignInOn, c.modifiedOn';

    return await cosmosDBQuery(`SELECT ${attributes} FROM c 
        WHERE c.stateCode=0 AND c.entityName=@entityName 
        AND c.${type}=@value`, [
        {
            name: '@value',
            value: value
        },
        {
            name: '@entityName',
            value: 'User'
        }
    ]);
};

export const getUserVerificationCodes = async (userId: string, type: 'email' | 'mobile', codes: string): Promise<Record<string, any> | undefined> => {
    const users = await cosmosDBQuery(`SELECT * FROM c 
    WHERE c.id=@id AND
    ${type == 'email' ? 'c.emailVerificationCode=@codes' : 'c.mobileVerificationCode=@codes'}`, [
        {
            name: '@id',
            value: userId
        },
        {
            name: '@codes',
            value: codes
        }]);

    return users.length > 0 ? users[0] : undefined;

}

export const updateUserRoles = async (userId: string, roles: string[]): Promise<boolean> => {


    const user = await cosmosDBRetrieveById(userId);
    if (isNil(user)) return false;

    const newUser: Record<string, any> = { ...user, roles };

    //direct cosmosDb update
    await cosmosDBUpdate(newUser);
    await dynamoDBUpsert({ ...newUser, id: `user.${newUser.id}` }, DYNAMO_DB_TABLE_NAME_PROFILE, true);
    return true;
};

export const activateUser = async (userId: string, type: 'email' | 'mobile', codes: string, action: string): Promise<boolean> => {

    const verifiedUser = await getUserVerificationCodes(userId, type, codes);
    if (isNil(verifiedUser)) return false;

    const user = assign({}, verifiedUser, type == 'email' ?
        { emailVerifiedOn: utcISOString(), emailVerificationCode: newGuid().split("-")[0].toUpperCase() } :
        { mobileVerifiedOn: utcISOString(), mobileVerificationCode: newGuid().split("-")[0].toUpperCase() });

    if (action == 'activate-with-password' || action == 'activate-without-password') {
        user.statusCode = 10;
        user.statusCode_info = action;
    }

    //direct cosmosDb update
    await cosmosDBUpdate(user);
    await dynamoDBUpsert({ ...user, id: `user.${user.id}` }, DYNAMO_DB_TABLE_NAME_PROFILE, true);
    return true;
};


export const changeUserPassword = async (solution: Record<string, any>, userId: string, password: string, type: 'email' | 'mobile', codes: string): Promise<boolean> => {

    const verifiedUser = await getUserVerificationCodes(userId, type, codes);
    if (isNil(verifiedUser)) return false;

    const organizationId = verifiedUser.organizationId;

    await updateCognitoPassword(
        solution.auth.cognito.userPoolId,
        solution.auth.cognito.userPoolLambdaClientId,
        organizationId,
        userId,
        password
    );

    return true;
}


export const createUser = async (
    context: {
        userId: string,
        organizationId: string,
        solutionId: string,
        userPoolId: string,
        userPoolLambdaClientId: string,
        passwordRules?: {
            needLowerCaseLetter: boolean,
            needUpperCaseLetter: boolean,
            needDigit: boolean,
            needSepcialChar: boolean,
            minLen: number
        }
    },
    userData: Record<string, any>,
    type: 'email' | 'mobile',
    password: string,
    organizationData?: Record<string, any>
): Promise<Record<string, any>> => {

    if (isNil(organizationData)) organizationData = {};
    organizationData.userPoolId = context.userPoolId;
    organizationData.userPoolLambdaClientId = context.userPoolLambdaClientId;
    const organizationId: string | undefined = organizationData?.id;

    const source = 'createUser';
    const callerUserOrganizationId = context.organizationId;
    const { passwordRules, userPoolId, userPoolLambdaClientId, solutionId } = context;

    //delete the attribute that should not be provided during create user

    let user = { ...userData };
    delete user.emailVerifiedOn;
    delete user.mobileVerifiedOn;

    const { email, mobile } = user;

    if (!isNonEmptyString(type) || type == 'email' && !isEmail(email) || type == 'mobile' && !isPhoneNumber(mobile)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: `The ${type == 'email' ? 'email' : 'mobile number'} is invalid.`,
                parameters: { type, email, mobile }
            }
        }
    }

    //if organizationId is provied, it means the user will be created and added to the orgnization
    if (isNonEmptyString(organizationId)) {
        if (callerUserOrganizationId != organizationId) {
            throw {
                ...HTTPERROR_403,
                type: ERROR_PARAMETER_INVALID,
                source,
                detail: {
                    reason: 'The caller is from different organization.',
                    parameters: { callerId: callerUserOrganizationId, organizationId }
                }
            }
        }
    }

    if (isNonEmptyString(password)) {
        if (!isNil(passwordRules) && !isPassword(password, passwordRules)) {
            throw {
                ...HTTPERROR_400,
                type: ERROR_PARAMETER_INVALID,
                source,
                detail: {
                    reason: 'password',
                    parameters: { password }
                }
            }
        }
    }
    else {
        //auto generate a password
        password = `Aa-${newGuid()}!${(new Date()).getFullYear()}`;
    }


    const newUserId = user.id ? user.id : newGuid();
    const newOrganizationId = organizationId ? null : newGuid();

    let createdCosmosOrganizationId = '';
    let createdDynamoOrganizationId = '';
    let createdCosmosUserId = '';
    let createdDynamoUserId = '';
    let userToken: any = null;
    let organization: Record<string, any> = {};

    user.id = newUserId;

    try {

        if (_track) console.log('Check existing users.', { user });

        const existingUsers = await getUserOrgs(type == 'email' ? email : mobile, type == 'email' ? 'email' : 'mobile');
        let existingUser = isNonEmptyString(organizationId) && find(existingUsers, (u) => u.organizationId == organizationId)

        //create user in an existing organization, check whether the user alread exists
        if (isObject(existingUser)) {

            //retrieve the full record of the existing user
            existingUser = await cosmosDBRetrieveById(existingUser.id);
            // if (_track) console.log({existingUser: JSON.stringify(existingUser)});

            if (user.membership) {
                if (!existingUser.membership) existingUser.membership = {};
                user.membership = { ...existingUser.membership, ...user.membership };
            }

            delete user.id;
            user = cloneDeep({ ...existingUser, ...user });
            if (_track) console.log('The user data to update.', { user: JSON.stringify(user) });

            //If user exists, we will update and exit
            if (_track) console.log('Update user in the CosmosDB.', { user: JSON.stringify(user) });
            user = await updateRecord({ ...context, user }, user, { skipSecurityCheck: true, skipDuplicationCheck: true, skipSystemPropertyCheck: true });

            const updatedDynamoUserId = `user.${user.id}`;
            if (_track) console.log('Update user in the DynamoDB.', { updatedDynamoUserId });
            await dynamoDBUpsert({ ...user, id: updatedDynamoUserId }, DYNAMO_DB_TABLE_NAME_PROFILE, true);

            return { user, organization };

            // throw {
            //     ...HTTPERROR_400,
            //     type: 'ERROR_API_USEREXISTS',
            //     source,
            //     detail: {
            //         parameters: { type, email, mobile }
            //     }
            // }

        }

        context.userId = newUserId;
        if (organizationId) context.organizationId = organizationId;

        //If the new organizationId is provided, it means we will create a new organization
        if (newOrganizationId) {
            //create organization in cosmosDb
            createdCosmosOrganizationId = newOrganizationId;
            context.organizationId = newOrganizationId;
            if (_track) console.log('Create new organization in the CosmsDB.', { createdCosmosOrganizationId });

            organization = await createRecord(
                context,
                {
                    ...organizationData,
                    id: createdCosmosOrganizationId,
                    entityName: "Organization",
                    name: 'My Organization',
                    solutionId,
                    disableDelete: true
                }, { skipSecurityCheck: true });

            //create organization in dynamoDb
            const createdDynamoOrganizationId = `organization.${createdCosmosOrganizationId}`;

            if (_track) console.log('Create new organization in the DynamoDB.', { createdDynamoOrganizationId });
            await dynamoDBCreate({ ...organization, id: createdDynamoOrganizationId }, DYNAMO_DB_TABLE_NAME_PROFILE);

        }

        user.organizationId = context.organizationId;
        user.key = serialNumber();
        user.entityName = "User";
        user.emailVerificationCode = newGuid().split("-")[0].toUpperCase();
        user.mobileVerificationCode = newGuid().split("-")[0].toUpperCase();
        user.disableDelete = true;


        //user.createdFromDomain = getDomain(context.event, false);

        user = await processUpsertData({ ...context, user }, user, { skipExistingData: true });


        //insert user into cosmosDb
        if (_track) console.log('Create new user in the CosmsDB.', { user });
        user = await createRecord(context, user, { skipSecurityCheck: true });

        // await cosmosDBUpsert(user);
        createdCosmosUserId = user.id;

        //insert user into dynamoDb
        const createdDynamoUserId = `user.${user.id}`;
        if (_track) console.log('Create new user in the DynamoDB.', { createdDynamoUserId });
        await dynamoDBCreate({ ...user, id: createdDynamoUserId }, DYNAMO_DB_TABLE_NAME_PROFILE);

        const userTokenData = { userId: newUserId, organizationId: context.organizationId, roles: user.roles, licenses: user.licenses };
        if (_track) console.log('Create new user token.', { userTokenData });
        userToken = await createToken(newUserId, 'user', userTokenData);

        if (_track) console.log('Create new user in Cognito.', {
            userPoolId: userPoolId,
            userPoolLambdaClientId,
            organizationId: context.organizationId,
            userId: user.id,
            password
        });
        await createCognitoUser(
            userPoolId,
            userPoolLambdaClientId,
            context.organizationId,
            user.id,
            password
        );

        return { user, organization };

    } catch (error) {

        if (_track) console.error(error);

        //we will have to rollback what we have done
        if (isNonEmptyString(createdCosmosOrganizationId)) await cosmosDBDelete(organization);
        if (isNonEmptyString(createdDynamoOrganizationId)) await dynamoDBDelete(createdDynamoOrganizationId, DYNAMO_DB_TABLE_NAME_PROFILE);

        if (isNonEmptyString(createdCosmosUserId)) await cosmosDBDelete(user);
        if (isNonEmptyString(createdDynamoUserId)) await dynamoDBDelete(createdDynamoUserId, DYNAMO_DB_TABLE_NAME_PROFILE);

        if (isObject(userToken)) {
            await dynamoDBDelete(`tokens.${createdCosmosUserId}`, DYNAMO_DB_TABLE_NAME_PROFILE);
        }

        throw {
            ...HTTPERROR_400,
            type: 'ERROR_API_CREATE_USER',
            source,
            detail: {
                error
            }
        }
    }
};


export const updateUser = async (context: Record<string, any>, user: Record<string, any>): Promise<Record<string, any>> => {

    const source = 'updateUser';

    if (!(isObject(user) && isNonEmptyString(user.id))) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'user.id'
            }
        }
    }

    if (user.entityName != 'User') {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'user.entityName="User"'
            }
        }
    }

    if (!(hasRole(context, 'ORG-ADMIN') || hasRole(context, 'USER-MANAGER') || user.id == context.userId)) {
        throw {
            ...HTTPERROR_403,
            type: ERROR_PERMISSION_DENIED,
            source,
            detail: {
                reason: 'The caller has no permission to update a user. (Only the context user or the user with ORG-ADMIN or USER-MANAGER role can update this user record.)'
            }
        }
    }

    //updateRecord function will not change roles and licenses
    let newUser = await updateRecord(context, user, { skipSecurityCheck: true });

    //update roles if necessary
    if (JSON.stringify(isArray(user?.roles) ? user?.roles : []) != JSON.stringify(isArray(newUser?.roles) ? newUser?.roles : [])) {
        if ((hasRole(context, 'ORG-ADMIN') || hasRole(context, 'USER-MANAGER'))) {
            if (_track) console.log('Update user roles.')
            newUser.roles = isArray(user?.roles) ? user?.roles : [];
            newUser = await cosmosDBUpdate(newUser);
        }
        else {
            if (_track) console.log(`The user ${context.userId} can not update rules. (need ORG-ADMIN or USER-MANAGER)`)
        }
    }

    await dynamoDBUpsert({ ...newUser, id: `user.${newUser.id}` }, DYNAMO_DB_TABLE_NAME_PROFILE, true);

    return newUser;
}

//We do not delete any user in our platform, just simply change stateCode=-1;
export const deleteUser = async (context: Record<string, any>, id: string, statusCode?: number): Promise<Record<string, any>> => {

    const source = 'deleteUser';

    if (!isNonEmptyString(id)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'id'
            }
        }
    }

    const user: any = await cosmosDBRetrieveById(id);
    if (!user || user && user.entityName != 'User') {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'The user does not exist'
            }
        }
    }

    if (!(statusCode && isNumber(statusCode) && statusCode < 0)) statusCode = -1;

    const utcNow = utcISOString();
    await cosmosDBUpdate({ ...user, stateCode: -1, statusCode, modifiedOn: utcNow, modifiedBy: context.userId })
    await dynamoDBUpsert({ ...user, stateCode: -1, statusCode, id: `user.${user.id}`, modifiedOn: utcNow, modifiedBy: context.userId }, DYNAMO_DB_TABLE_NAME_PROFILE, true);

    return user;
}

export const sendVerifyToken = async (
    solutionId: string,
    userId: string,
    type: string,
    action: string,
    domain?: string): Promise<string> => {

    //retrieve user now
    const user = await cosmosDBRetrieveById(userId);
    if (isNil(user)) return '';

    const code = type == 'email' ? user['emailVerificationCode'] : user['mobileVerificationCode'];
    const tokenId = `verification.${userId}`;
    const email = user['email'];
    const mobile = user['mobile'];

    //create token;
    await createToken(tokenId, action, code);

    const tokenInEmail = await encryptToken(`${userId}|${action}|${type}|${type == 'email' ? email : mobile}|${newGuid()}`);

    const emailTemplateS3 = await s3Get(S3_BUCKET_NAME_DATA, `${solutionId}/email-${action}.json`);
    const emailTemplate = emailTemplateS3 && JSON.parse(emailTemplateS3.content);
    const sender = getRecordEmailAddress(emailTemplate.sender);
    const senderService = emailTemplate?.sender?.service ? emailTemplate?.sender?.service : null;
    if (_track) console.log({
        emailTemplate: JSON.stringify(emailTemplate),
        sender: emailTemplate?.sender ? JSON.stringify(emailTemplate?.sender) : null,
        senderService,
        service: (senderService == 'sg' || senderService == 'ses')
    });

    const service = (senderService == 'sg' || senderService == 'ses') ? senderService : 'ses';
    const to = getRecordEmailAddress(user);
    const cc: any = map(emailTemplate.cc, (c) => getRecordEmailAddress(c));

    const context = { solutionId, userId: user.id, organizationId: user.organizationId, user };

    const protocol = domain == 'localhost' ? 'http' : 'https';

    const htmlMessage = isNonEmptyString(emailTemplate?.htmlMessage) ? await processContent(context, true, emailTemplate?.htmlMessage, { ...user, token: tokenInEmail, domain, protocol }) : '';
    const textMessage = isNonEmptyString(emailTemplate?.textMessage) ? await processContent(context, true, emailTemplate?.textMessage, { ...user, token: tokenInEmail, domain, protocol }) : '';

    if (sender && to && (isNonEmptyString(htmlMessage) || isNonEmptyString(textMessage))) {
        if (_track) console.log({ service, sender, to: [to], subject: emailTemplate?.subject, htmlMessage, textMessage, cc });
        await sendEmail(service, sender, [to], emailTemplate?.subject, htmlMessage, textMessage, cc);

        if (action == 'activate-with-password' || action == 'activate-without-password') {
            user.statusCode = 5; //invite out
            user.statusCode_info = action; //invite out
            await cosmosDBUpdate(user);
        }

    }

    return tokenInEmail;
}

// export const deleteUserCompletely = async (context, id) => {

//     const { organizationId, userId } = context;
//     const toDeleteUserId = id;

//     if (sameGuid(toDeleteUserId, userId)) {
//         throw ('ERROR_API_DELETE_USER_DELETE_SELF', { statusCode: 403, message: 'User can not delete self.' });
//     }

//     const toDeleteUser = await cosmosDBRetrieve(toDeleteUserId);

//     if (!(isObject(toDeleteUser) && toDeleteUser.id)) {
//         throw ('ERROR_API_DELETE_USER_NOT_EXISTS', { statusCode: 400, toDeleteUserId });
//     }

//     const curUserIsRootAdmin = !hasRole(context, 'SOLUTION-ADMIN');
//     const curUserIsOrgAdmin = hasRole(context, 'ORG-ADMIN') && sameGuid(toDeleteUser.organizationId, organizationId);

//     if (!curUserIsRootAdmin && !curUserIsOrgAdmin) {
//         return throw ('ERROR_API_DELETE_USER_NEED_ORG_ROOT_ADMIN',
//         {
//             statusCode: 403,
//             message: `Only the user with ORG-ADMIN or SOLUTION-ADMIN role can delete the user (${toDeleteUserId}).`
//         });
//     }

//     const toDeleteUserOrganizationId = toDeleteUser.organizationId;
//     const toDeleteUserOrganization = await cosmosDBRetrieve(toDeleteUserOrganizationId);

//     const isDeletingOwnerOfOrganization = sameGuid(toDeleteUserOrganization.ownedBy, id);
//     if (isDeletingOwnerOfOrganization && !curUserIsRootAdmin) {
//         return throw ('ERROR_API_DELETE_USER_NEED_ROOT_ADMIN',
//         {
//             statusCode: 403,
//             message: `Only the user with SOLUTION-ADMIN role can delete the organization owner (${toDeleteUserId}).`
//         });
//     }

//     //find the records owned, created or modified by the user
//     //We only delete non-dependency user that has only two records associated to the user
//     //One record is the organization created for the user and the other is the user record itself
//     const userData = await cosmosDBQuery(
//         `SELECT TOP 1 c.id FROM c WHERE c.id NOT IN (@orgId,@userId) AND (c.createdBy=@userId OR c.ownedBy=@userId OR c.modifiedBy=@userId)`,
//         [
//             {
//                 name: '@userId',
//                 value: toDeleteUserId
//             },
//             {
//                 name: '@orgId',
//                 value: toDeleteUserOrganizationId
//             }
//         ]);


//     //we need to make sure the user does not have associated records
//     if (userData.length > 0) {
//         return throw ('ERROR_API_USER_DELETE_USERHASDATA', {
//             statusCode: 400,
//             message: `There are data depending on the user (${toDeleteUserId}), the user can not be deleted.`
//         });
//     }

//     let deleteOrg = false;

//     //If the user created by him/herself, it means this is the owner of the organization or the first user of the organization
//     if (isDeletingOwnerOfOrganization || sameGuid(toDeleteUser.id, toDeleteUser.createdBy)) {
//         //Find whether there's other user in the organization 
//         const orgUsers = await cosmosDBQuery(
//             'SELECT c.id FROM c WHERE c.entityName=@entityName AND c.organizationId=@organizationId',
//             [
//                 {
//                     name: '@organizationId',
//                     value: toDeleteUserOrganizationId
//                 },
//                 {
//                     name: '@entityName',
//                     value: 'User'
//                 }
//             ]);


//         if (orgUsers.length == 1) deleteOrg = true;
//     }


//     //Delete Organization
//     if (deleteOrg) {
//         await cosmosDb.deleteRecord(context, toDeleteUserOrganizationId, { skipSecurityCheck: true });
//         await dynamoDb.deleteRecord(`organization.${toDeleteUserOrganizationId}`, DYNAMO_DB_TABLE_NAME_PROFILE);
//     }

//     //Delete User
//     await cosmosDb.deleteRecord(context, toDeleteUserId, { skipSecurityCheck: true });
//     await dynamoDb.deleteRecord(`user.${toDeleteUserId}`, DYNAMO_DB_TABLE_NAME_PROFILE);

//     await _dynamoDb.delete({ TableName: DYNAMO_DB_TABLE_NAME_PROFILE, Key: { id: `tokens.${toDeleteUserId}` } }).promise();

//     //Delete Cognito User
//     await cognito.deleteUser(solution.auth.cognito.userPoolId, toDeleteUserOrganizationId, toDeleteUserId);

//     return { toDeleteUserOrganizationId, toDeleteUserId };

// };
