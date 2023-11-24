import json

# Read JSON data from file
with open('atit.json', 'r') as file:
    json_data = file.read()

# Parse JSON data
data = json.loads(json_data)

# Loop through portfolio array
for i, item in enumerate(data['portfolio']):
    item['id'] = i

# Convert back to JSON
updated_json_data = json.dumps(data)

# Save changes to the same file
with open('atit.json', 'w') as file:
    file.write(updated_json_data)

print(updated_json_data)