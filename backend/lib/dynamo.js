import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TABLE = process.env.TABLE_NAME
const GSI1 = 'GSI1'

export async function getItem(key) {
  const { Item } = await client.send(
    new GetCommand({ TableName: TABLE, Key: key }),
  )
  return Item || null
}

// Put with an optional condition (e.g. attribute_not_exists(PK) to avoid
// clobbering an existing item). Returns true on success, false if the
// condition failed.
export async function putItem(item, condition) {
  const options = typeof condition === 'string'
    ? { ConditionExpression: condition }
    : condition
      ? {
          ...(condition.conditionExpression
            ? { ConditionExpression: condition.conditionExpression }
            : {}),
          ...(condition.expressionAttributeValues
            ? { ExpressionAttributeValues: condition.expressionAttributeValues }
            : {}),
        }
      : {}
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ...options,
      }),
    )
    return true
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

export async function deleteItem(key) {
  await client.send(new DeleteCommand({ TableName: TABLE, Key: key }))
}

// Query one partition, optionally filtered to a sort-key prefix.
export async function queryPrefix(pk, skPrefix) {
  const { Items } = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: skPrefix
        ? 'PK = :pk AND begins_with(SK, :sk)'
        : 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': pk,
        ...(skPrefix ? { ':sk': skPrefix } : {}),
      },
    }),
  )
  return Items || []
}

// Query the GSI1 index by its partition key, optionally filtered to a
// GSI1SK prefix. Used to list "the groups this account belongs to".
export async function queryIndexPrefix(gsi1pk, gsi1skPrefix) {
  const { Items } = await client.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: gsi1skPrefix
        ? 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)'
        : 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': gsi1pk,
        ...(gsi1skPrefix ? { ':sk': gsi1skPrefix } : {}),
      },
    }),
  )
  return Items || []
}
