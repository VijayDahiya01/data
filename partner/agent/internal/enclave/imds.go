package enclave

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// IMDSCredentials fetches the host's instance-role credentials with IMDSv2:
// a session token first, then the role's name and its credentials. base is
// http://169.254.169.254/latest, or a test server.
func IMDSCredentials(client *http.Client, base string) func(ctx context.Context) (Credentials, error) {
	get := func(ctx context.Context, method, path, token string) (string, error) {
		req, err := http.NewRequestWithContext(ctx, method, base+path, nil)
		if err != nil {
			return "", err
		}
		if token == "" {
			req.Header.Set("X-aws-ec2-metadata-token-ttl-seconds", "300")
		} else {
			req.Header.Set("X-aws-ec2-metadata-token", token)
		}
		res, err := client.Do(req)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		body, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		if err != nil {
			return "", err
		}
		if res.StatusCode != http.StatusOK {
			return "", fmt.Errorf("instance metadata %s answered %d", path, res.StatusCode)
		}
		return strings.TrimSpace(string(body)), nil
	}
	return func(ctx context.Context) (Credentials, error) {
		token, err := get(ctx, http.MethodPut, "/api/token", "")
		if err != nil {
			return Credentials{}, err
		}
		roles, err := get(ctx, http.MethodGet, "/meta-data/iam/security-credentials/", token)
		if err != nil {
			return Credentials{}, err
		}
		role, _, _ := strings.Cut(roles, "\n")
		if role == "" {
			return Credentials{}, fmt.Errorf("the instance has no role")
		}
		raw, err := get(ctx, http.MethodGet, "/meta-data/iam/security-credentials/"+role, token)
		if err != nil {
			return Credentials{}, err
		}
		var creds Credentials
		if err := json.Unmarshal([]byte(raw), &creds); err != nil {
			return Credentials{}, err
		}
		return creds, nil
	}
}
