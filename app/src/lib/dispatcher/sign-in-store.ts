import { Emitter, Disposable } from 'event-kit'
import { User } from '../../models/user'
import { assertNever, fatalError } from '../fatal-error'
import { askUserToOAuth } from '../../lib/oauth'
import { validateURL, InvalidURLErrorName, InvalidProtocolErrorName } from '../../ui/lib/enterprise-validate-url'

import {
  createAuthorization,
  AuthorizationResponse,
  fetchUser,
  AuthorizationResponseKind,
  getHTMLURL,
  getDotComAPIEndpoint,
  getEnterpriseAPIURL,
  fetchMetadata,
} from '../../lib/api'

import { AuthenticationMode } from '../../lib/2fa'

import { minimumSupportedEnterpriseVersion } from '../../lib/enterprise'

/**
 * An enumeration of the possible steps that the sign in
 * store can be in save for the unitialized state (null).
 */
export enum SignInStep {
  EndpointEntry,
  Authentication,
  TwoFactorAuthentication,
  Success,
}

/**
 * The union type of all possible states that the sign in
 * store can be in save the unitialized state (null).
 */
export type SignInState =
  IEndpointEntryState |
  IAuthenticationState |
  ITwoFactorAuthenticationState |
  ISuccessState

/**
 * Base interface for shared properties between states
 */
export interface ISignInState {
  /**
   * The sign in step represented by this state
   */
  readonly kind: SignInStep

  /**
   * An error which, if present, should be presented to the
   * user in close proximity to the actions or input fields
   * related to the current step.
   */
  readonly error: Error | null

  /**
   * A value indicating whether or not the sign in store is
   * busy processing a request. While this value is true all
   * form inputs and actions save for a cancel action should
   * be disabled and the user should be made aware that the
   * sign in process is ongoing.
   */
  readonly loading: boolean
}

/**
 * State interface representing the endpoint entry step.
 * This is the initial step in the Enterprise sign in flow
 * and is not present when signing in to GitHub.com
 */
export interface IEndpointEntryState extends ISignInState {
  readonly kind: SignInStep.EndpointEntry
}

/**
 * State interface representing the Authentication step where
 * the user provides credentials and/or initiates a browser
 * OAuth sign in process. This step occurs as the first step
 * when signing in to GitHub.com and as the second step when
 * signing in to a GitHub Enterprise instance.
 */
export interface IAuthenticationState extends ISignInState {
  readonly kind: SignInStep.Authentication

  /**
   * The URL to the host which we're currently authenticating
   * against. This will be either https://api.github.com when
   * signing in against GitHub.com or a user-specified
   * URL when signing in against a GitHub Enterprise instance.
   */
  readonly endpoint: string

  /**
   * A value indicating whether or not the endpoint supports
   * basic authentication (i.e. username and password). All
   * GitHub Enterprise instances support OAuth (or web flow
   * sign-in).
   */
  readonly supportsBasicAuth: boolean

  /**
   * The endpoint-specific URL for resetting credentials.
   */
  readonly forgotPasswordUrl: string
}

/**
 * State interface representing the TwoFactorAuthentication
 * step where the user provides an OTP token. This step
 * occurs after the authentication step both for GitHub.com,
 * and GitHub Enterprise when the user has enabled two factor
 * authentication on the host.
 */
export interface ITwoFactorAuthenticationState extends ISignInState {
  readonly kind: SignInStep.TwoFactorAuthentication

  /**
   * The URL to the host which we're currently authenticating
   * against. This will be either https://api.github.com when
   * signing in against GitHub.com or a user-specified
   * URL when signing in against a GitHub Enterprise instance.
   */
  readonly endpoint: string

  /**
   * The username specified by the user in the preceeding
   * Authentication step
   */
  readonly username: string

  /**
   * The password specified by the user in the preceeding
   * Authentication step
   */
  readonly password: string

  /**
   * The 2FA type expected by the GitHub endpoint.
   */
  readonly type: AuthenticationMode
}

/**
 * Sentinel step representing a successful sign in process. Sign in
 * components may use this as a signal to dismiss the ongoing flow
 * or to show a message to the user indicating that they've been
 * successfully signed in.
 */
export interface ISuccessState {
  readonly kind: SignInStep.Success
}

/**
 * A store encapsulating all logic related to signing in a user
 * to GitHub.com, or a GitHub Enterprise instance.
 */
export class SignInStore {
  private readonly emitter = new Emitter()
  private state: SignInState | null = null

  private emitUpdate() {
    this.emitter.emit('did-update', this.getState())
  }

  private emitAuthenticate(user: User) {
    this.emitter.emit('did-authenticate', user)
  }

  private emitError(error: Error) {
    this.emitter.emit('did-error', error)
  }

  /** Register a function to be called when the store updates. */
  public onDidUpdate(fn: (state: ISignInState) => void): Disposable {
    return this.emitter.on('did-update', fn)
  }

  /**
   * Registers an event handler which will be invoked whenever
   * a user has successfully completed a sign-in process.
   */
  public onDidAuthenticate(fn: (user: User) => void): Disposable {
    return this.emitter.on('did-authenticate', fn)
  }

  /**
   * Register an even handler which will be invoked whenever
   * an unexpected error occurs during the sign-in process. Note
   * that some error are handled in the flow and passed along in
   * the sign in state for inline presentation to the user.
   */
  public onDidError(fn: (error: Error) => void): Disposable {
    return this.emitter.on('did-error', fn)
  }

  /**
   * Returns the current state of the sign in store or null if
   * no sign in process is in flight.
   */
  public getState(): SignInState | null {
    return this.state
  }

  /**
   * Update the internal state of the store and emit an update
   * event.
   */
  private setState(state: SignInState | null) {
    this.state = state
    this.emitUpdate()
  }

  private async endpointSupportsBasicAuth(endpoint: string): Promise<boolean> {
    const response = await fetchMetadata(endpoint)

    if (response) {
      if (response.verifiable_password_authentication === false) {
        return false
      } else {
        return true
      }
    } else {
      throw new Error(`Unable to authenticate with the GitHub Enterprise instance. Verify that the URL is correct and that your GitHub Enterprise instance is running version ${minimumSupportedEnterpriseVersion} or later.`)
    }
  }

  private getForgotPasswordURL(endpoint: string): string {
    return `${getHTMLURL(endpoint)}/password_reset`
  }

  /**
   * Clear any in-flight sign in state and return to the
   * initial (no sign-in) state.
   */
  public reset() {
    this.setState(null)
  }

  /**
   * Initiate a sign in flow for github.com. This will put the store
   * in the Authentication step ready to receive user credentials.
   */
  public beginDotComSignIn() {
    const endpoint = getDotComAPIEndpoint()

    this.setState({
      kind: SignInStep.Authentication,
      endpoint,
      supportsBasicAuth: true,
      error: null,
      loading: false,
      forgotPasswordUrl: this.getForgotPasswordURL(endpoint),
    })
  }

  /**
   * Attempt to advance from the authentication step using a username
   * and password. This method must only be called when the store is
   * in the authentication step or an error will be thrown. If the
   * provided credentials are valid the store will either advance to
   * the Success step or to the TwoFactorAuthentication step if the
   * user has enabled two factor authentication.
   *
   * If an error occurs during sign in (such as invalid credentials)
   * the authentication state will be updated with that error so that
   * the responsible component can present it to the user.
   */
  public async authenticateWithBasicAuth(username: string, password: string): Promise<void> {
    const currentState = this.state

    if (!currentState || currentState.kind !== SignInStep.Authentication) {
      const stepText = currentState ? currentState.kind : 'null'
      return fatalError(`Sign in step '${stepText}' not compatible with authentication`)
    }

    const endpoint = currentState.endpoint

    this.setState({ ...currentState, loading: true })

    let response: AuthorizationResponse
    try {
      response = await createAuthorization(endpoint, username, password, null)
    } catch (e) {
      this.emitError(e)
      return
    }

    if (!this.state || this.state.kind !== SignInStep.Authentication) {
      // Looks like the sign in flow has been aborted
      return
    }

    if (response.kind === AuthorizationResponseKind.Authorized) {
      const token = response.token
      const user = await fetchUser(endpoint, token)

      if (!this.state || this.state.kind !== SignInStep.Authentication) {
        // Looks like the sign in flow has been aborted
        return
      }

      this.emitAuthenticate(user)
      this.setState({ kind: SignInStep.Success })
    } else if (response.kind === AuthorizationResponseKind.TwoFactorAuthenticationRequired) {
      this.setState({
        kind: SignInStep.TwoFactorAuthentication,
        endpoint,
        username,
        password,
        type: response.type,
        error: null,
        loading: false,
      })
    } else {
      if (response.kind === AuthorizationResponseKind.Error) {
        if (response.response.error) {
          this.emitError(response.response.error)
        } else {
          this.emitError(new Error(`The server responded with an error while attempting to authenticate (${response.response.statusCode})\n\n${response.response.body}`))
        }
        this.setState({ ...currentState, loading: false })
      } else if (response.kind === AuthorizationResponseKind.Failed) {
        this.setState({
          ...currentState,
          loading: false,
          error: new Error('Incorrect username or password.'),
        })
      } else {
        return assertNever(response, `Unsupported response: ${response}`)
      }
    }
  }

  /**
   * Initiate an OAuth sign in using the system configured browser.
   * This method must only be called when the store is in the authentication
   * step or an error will be thrown.
   *
   * The promise returned will only resolve once the user has successfully
   * authenticated. If the user terminates the sign-in process by closing
   * their browser before the protocol handler is invoked, by denying the
   * protocol handler to execute or by providing the wrong credentials
   * this promise will never complete.
   */
  public async authenticateWithBrowser(): Promise<void> {
    const currentState = this.state

    if (!currentState || currentState.kind !== SignInStep.Authentication) {
      const stepText = currentState ? currentState.kind : 'null'
      return fatalError(`Sign in step '${stepText}' not compatible with browser authentication`)
    }

    this.setState({ ...currentState, loading: true })

    let user: User
    try {
      user = await askUserToOAuth(currentState.endpoint)
    } catch (e) {
      this.setState({ ...currentState, error: e, loading: false })
      return
    }

    if (!this.state || this.state.kind !== SignInStep.Authentication) {
      // Looks like the sign in flow has been aborted
      return
    }

    this.emitAuthenticate(user)
    this.setState({ kind: SignInStep.Success })
  }

  /**
   * Initiate a sign in flow for a GitHub Enterprise instance. This will
   * put the store in the EndpointEntry step ready to receive the url
   * to the enterprise instance.
   */
  public beginEnterpriseSignIn() {
    this.setState({ kind: SignInStep.EndpointEntry, error: null, loading: false })
  }

  /**
   * Attempt to advance from the EndpointEntry step with the given endpoint
   * url. This method must only be called when the store is in the authentication
   * step or an error will be thrown.
   *
   * The provided endpoint url will be validated for syntactic correctness as
   * well as connectivity before the promise resolves. If the endpoint url is
   * invalid or the host can't be reached the promise will be rejected and the
   * sign in state updated with an error to be presented to the user.
   *
   * If validation is successful the store will advance to the authentication
   * step.
   */
  public async setEndpoint(url: string): Promise<void> {
    const currentState = this.state

    if (!currentState || currentState.kind !== SignInStep.EndpointEntry) {
      const stepText = currentState ? currentState.kind : 'null'
      return fatalError(`Sign in step '${stepText}' not compatible with endpoint entry`)
    }

    this.setState({ ...currentState, loading: true })

    let validUrl: string
    try {
      validUrl = validateURL(url)
    } catch (e) {
      let error = e
      if (e.name === InvalidURLErrorName) {
        error = new Error(`The GitHub Enterprise instance address doesn't appear to be a valid URL. We're expecting something like https://github.example.com.`)
      } else if (e.name === InvalidProtocolErrorName) {
        error = new Error('Unsupported protocol. Only http or https is supported when authenticating with GitHub Enterprise instances.')
      }

      this.setState({ ...currentState, loading: false, error })
      return
    }

    const endpoint = getEnterpriseAPIURL(validUrl)
    try {
      const supportsBasicAuth = await this.endpointSupportsBasicAuth(endpoint)

      if (!this.state || this.state.kind !== SignInStep.EndpointEntry) {
        // Looks like the sign in flow has been aborted
        return
      }

      this.setState({
        kind: SignInStep.Authentication,
        endpoint,
        supportsBasicAuth,
        error: null,
        loading: false,
        forgotPasswordUrl: this.getForgotPasswordURL(endpoint),
      })
    } catch (e) {
      let error = e
      // We'll get an ENOTFOUND if the address couldn't be resolved.
      if (e.code === 'ENOTFOUND') {
        error = new Error('The server could not be found. Please verify that the URL is correct and that you have a stable internet connection.')
      }

      this.setState({ ...currentState, loading: false, error })
    }
  }

  /**
   * Attempt to complete the sign in flow with the given OTP token.\
   * This method must only be called when the store is in the
   * TwoFactorAuthentication step or an error will be thrown.
   *
   * If the provided token is valid the store will advance to
   * the Success step.
   *
   * If an error occurs during sign in (such as invalid credentials)
   * the authentication state will be updated with that error so that
   * the responsible component can present it to the user.
   */
  public async setTwoFactorOTP(otp: string) {

    const currentState = this.state

    if (!currentState || currentState.kind !== SignInStep.TwoFactorAuthentication) {
      const stepText = currentState ? currentState.kind : 'null'
      return fatalError(`Sign in step '${stepText}' not compatible with two factor authentication`)
    }

    this.setState({ ...currentState, loading: true })

    let response: AuthorizationResponse

    try {
      response = await createAuthorization(
        currentState.endpoint,
        currentState.username,
        currentState.password,
        otp
      )
    } catch (e) {
      this.emitError(e)
      return
    }

    if (!this.state || this.state.kind !== SignInStep.TwoFactorAuthentication) {
      // Looks like the sign in flow has been aborted
      return
    }

    if (response.kind === AuthorizationResponseKind.Authorized) {
      const token = response.token
      const user = await fetchUser(currentState.endpoint, token)

      if (!this.state || this.state.kind !== SignInStep.TwoFactorAuthentication) {
        // Looks like the sign in flow has been aborted
        return
      }

      this.emitAuthenticate(user)
      this.setState({ kind: SignInStep.Success })
    } else {
      switch (response.kind) {
        case AuthorizationResponseKind.Failed:
        case AuthorizationResponseKind.TwoFactorAuthenticationRequired:
          this.setState({
            ...currentState,
            loading: false,
            error: new Error('Two-factor authentication failed.'),
          })
          break
        case AuthorizationResponseKind.Error:
          const error = response.response.error
          if (error) {
            this.emitError(error)
          } else {
            this.emitError(new Error(`The server responded with an error (${response.response.statusCode})\n\n${response.response.body}`))
          }
          break
        default:
          return assertNever(response, `Unknown response: ${response}`)
      }
    }
  }
}